// AWS Account Switcher - Service Worker

// Import crypto utilities for password decryption
importScripts('crypto-utils.js');

// Debug mode - set to true to enable console logging
const DEBUG_MODE = true;

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
async function getDecryptedPassword(storedPassword, domain) {
    if (typeof CryptoUtils !== 'undefined' && CryptoUtils.isEncrypted(storedPassword)) {
        return await CryptoUtils.decryptPassword(storedPassword, domain);
    }
    return storedPassword;
}

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

// Auto-detect AWS app from Okta apps list
function autoDetectAwsApp(okta_data) {
    debugLog("Auto-detecting AWS app from Okta apps data");
    debugLog("Okta data type:", typeof okta_data, Array.isArray(okta_data) ? "array" : "not array");

    if (!okta_data) {
        debugLog("Invalid Okta apps data - null or undefined");
        chrome.storage.local.set({
            "login_status": {
                "status": "failed",
                "message": "Failed to load Okta apps"
            }
        });
        safeSendMessage({"method": "UpdateLoginStatus"});
        return;
    }

    // Handle different response structures from Okta API
    let allApps = [];

    const collectFromTab = tab => {
        if (Array.isArray(tab.apps)) {
            allApps = allApps.concat(tab.apps);
        }
        // Expanded format from ?expand=items,items.resource: each tab has `items`,
        // and each item has the app metadata under `.resource`.
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

    debugLog("Total apps found:", allApps.length);
    if (allApps.length > 0) {
        debugLog("Sample app structure:", JSON.stringify(allApps[0]).substring(0, 200));
    } else {
        // Log the raw data structure for debugging
        debugLog("No apps extracted. Raw data structure:", JSON.stringify(okta_data).substring(0, 500));
    }

    // If no apps found, try to show a helpful message but still mark as success (logged in)
    if (allApps.length === 0) {
        debugLog("No apps could be extracted from Okta response");
        chrome.storage.local.set({
            "login_status": {
                "status": "success",
                "message": "Logged in! No apps found - use Get Accounts."
            }
        });
        safeSendMessage({"method": "UpdateLoginStatus"});
        return;
    }

    // Look for AWS-related apps
    // Match by label containing "AWS" or "Amazon" (case insensitive)
    // Or by linkUrl containing "amazon" or "aws"
    const awsApp = allApps.find(app => {
        const label = (app.label || app.name || "").toLowerCase();
        const url = (app.linkUrl || app.href || "").toLowerCase();

        const isAwsApp = label.includes("aws") ||
                         label.includes("amazon") ||
                         url.includes("amazon.com") ||
                         url.includes("aws.amazon");

        if (isAwsApp) {
            debugLog("Found potential AWS app:", app.label || app.name, app.linkUrl || app.href);
        }

        return isAwsApp;
    });

    if (awsApp) {
        debugLog("AWS app detected:", awsApp.label || awsApp.name);

        // Save to settings
        chrome.storage.local.get(["settings"], function(result) {
            if (result.settings === undefined) {
                result.settings = {};
            }

            result.settings.aws_app = {
                label: awsApp.label || awsApp.name,
                url: awsApp.linkUrl || awsApp.href
            };

            chrome.storage.local.set(result, function() {
                debugLog("AWS app saved to settings:", result.settings.aws_app);

                chrome.storage.local.set({
                    "login_status": {
                        "status": "success",
                        "message": "Logged in! Loading accounts..."
                    }
                });
                safeSendMessage({"method": "UpdateLoginStatus"});

                // Auto-trigger account loading after AWS app is saved
                setTimeout(() => get_all_accounts(), 500);
            });
        });
    } else {
        // No AWS app found in API response, try dashboard detection
        debugLog("No AWS app found in Okta API response, trying dashboard detection...");
        handlePostLoginAccountLoad();
    }
}

// Helper function to handle post-login account loading
function handlePostLoginAccountLoad() {
    chrome.action.setBadgeText({text: ""});
    chrome.storage.local.get(["settings"], function(result) {
        if (result.settings && result.settings.aws_app && result.settings.aws_app.url) {
            chrome.storage.local.set({
                "login_status": {
                    "status": "success",
                    "message": "Logged in! Loading accounts..."
                }
            });
            safeSendMessage({"method": "UpdateLoginStatus"});
            setTimeout(() => get_all_accounts(), 500);
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

                        // Save the detected AWS app
                        chrome.storage.local.get(["settings"], function(result) {
                            if (!result.settings) result.settings = {};
                            result.settings.aws_app = {
                                label: awsApp.label,
                                url: awsApp.url
                            };
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

// Listen for extension startup
chrome.runtime.onStartup.addListener(() => {
    debugLog('Extension startup - starting keepalive');
    startKeepAlive();
});

// Listen for extension install
chrome.runtime.onInstalled.addListener(() => {
    debugLog('Extension installed - starting keepalive');
    startKeepAlive();
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

function get_all_accounts() {
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
    safeSendMessage({"method": "UpdateAccountsStatus"});
    aws_login(function(tab_id, portalHost){
        chrome.storage.local.get(["settings"], settings_storage => {
            const flow_mode = (settings_storage.settings && settings_storage.settings.aws_flow_mode) || "access_portal";
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
                    if (settings_storage.settings === undefined) {settings_storage.settings = {}}
                    if (settings_storage.settings.role_filters === undefined) {settings_storage.settings.role_filters = []}
                    const role_filters = settings_storage.settings.role_filters;
                    parsed.forEach(a => {
                        if (role_filters.length > 0 && role_filters.indexOf(a.role) === -1) {
                            if (accounts_storage.accounts[a.account_name] !== undefined) {
                                delete accounts_storage.accounts[a.account_name];
                            }
                        } else {
                            if (accounts_storage.accounts[a.account_name] === undefined) {
                                accounts_storage.accounts[a.account_name] = {"id": a.account_id, "status": "expired"};
                            }
                        }
                    });
                    chrome.storage.local.set(accounts_storage);
                    chrome.tabs.remove(tab_id);
                    chrome.storage.local.set({accountsstatus: "ready"})
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Successfully retrieved the list of AWS accounts."}})
                    safeSendMessage({"method": "UpdatePopup"});
                });
            }).catch((error) => {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
            });
        });
    })
}

function change_account(account){
    debugLog('change_account called for:', account);
    debugLog('Switching to account:', account);
    chrome.cookies.getAll({"domain": ".amazon.com"}, function(cookies_to_remove) {
        removeAwsCookies(cookies_to_remove);
        chrome.storage.local.get(["accounts"], function(result) {
            const cookies_to_add = result["accounts"][account].cookies;
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
            refresh_all_aws_tabs();
        });
    });
}

function refresh_all_aws_tabs() {
    chrome.tabs.query({"url": "*://*.console.aws.amazon.com/*"}, tabs => {
        if (tabs.length > 0) {
            for (let i = 0; i < tabs.length; i++) {
                chrome.tabs.reload(tabs[i].id);
            }
        } else {
            chrome.tabs.create({"url": "https://console.aws.amazon.com/"});
        }
        chrome.storage.local.set({"accounts_status": {"status": "success", "message": "🎉 Account changed successfully!"}})
        safeSendMessage({"method": "UpdateAccountsStatus"});
        chrome.tabs.query({ active: true, currentWindow: true }, active_tabs => {
            if (active_tabs[0] != undefined) {
                if (!active_tabs[0].url.includes("console.aws.amazon.com")) {
                    chrome.tabs.update(tabs[0].id, {selected: true});
                }
            }
        });
    });
}

function save(login, callback, originalAccountKey){
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Saving account cookies."}});
    safeSendMessage({"method": "UpdateAccountsStatus"});
    var account_name, account_id, account_role;
    chrome.cookies.getAll({"domain": ".amazon.com"}, function(all_cookies){

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
                if (all_cookies[i].domain === "amazon.com") {continue;}
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
                if (all_cookies[i].domain === "amazon.com") {continue;}
                try {
                    // JWT has 3 parts separated by dots: header.payload.signature
                    const jwtParts = all_cookies[i].value.split('.');
                    if (jwtParts.length >= 2) {
                        // Decode the payload (second part)
                        const payload = JSON.parse(atob(jwtParts[1]));
                        
                        if (payload.sub) {
                            // Extract from ARN format like: "arn:aws:iam::015428540659:user/route53"
                            const arnMatch = payload.sub.match(/arn:aws:iam::([0-9]+):(?:user|assumed-role)\/(.+?)(?:\/|$)/);
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

                if (storage.accounts[originalAccountKey] === undefined) {
                    console.error('save() originalAccountKey not found in storage:', originalAccountKey);
                    console.error('Available accounts:', Object.keys(storage.accounts));
                    callback();
                    return;
                }

                // Update the existing account with new cookies and ready status
                const newExpirationDate = (Date.now()/1000) + (SESSION_EXPIRATION_HOURS * 60 * 60);
                storage.accounts[originalAccountKey].cookies = all_cookies;
                storage.accounts[originalAccountKey].expirationDate = newExpirationDate;
                storage.accounts[originalAccountKey].status = "ready";
                if (extractedId) {
                    storage.accounts[originalAccountKey].id = extractedId;
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
            // Try to get existing expiration date using the original account key if provided
            const lookupKey = originalAccountKey || (account_name + '/' + account_role);
            if (storage.accounts[lookupKey] !== undefined) {
                expirationDate = storage.accounts[lookupKey].expirationDate;
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

            storage.accounts[accountKey] = accountData;
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

function login(account, callback) {
    debugLog('login called for account:', account);
    chrome.storage.local.get(["accounts"], function(storage){
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing AWS account login"}});
        safeSendMessage({"method": "UpdateAccountsStatus"});
        if (storage.accounts === undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        if (storage.accounts[account] === undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + account}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        var account_id = storage.accounts[account].id;
        var account_name = account.split('/')[0];
        var account_role = account.split('/')[1];
        debugLog(`Extracted account info: id="${account_id}", name="${account_name}", role="${account_role}"`);
        
        aws_login(function(tab_id, portalHost){
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
                        if (tab_url && tab_url.includes("console.aws.amazon.com")) {
                            clearInterval(console_timer);
                            console.log('[AWS Switcher] AWS console loaded:', tab_url);
                            setTimeout(() => {
                                save(true, function(){
                                    callback();
                                }, account);
                            }, 2000);
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
                debugLog('Access Portal mode, clicking role link for', account_id, account_role);
                chrome.scripting.executeScript({
                    target: {tabId: tab_id},
                    world: 'MAIN',
                    func: async (account_id, account_role) => {
                        const sleep = ms => new Promise(r => setTimeout(r, ms));

                        // Override window.open so the SPA's window.open(url, '_blank') navigates this tab.
                        window.open = function(url) {
                            if (url) {
                                try { window.location.href = url; } catch (e) {}
                            }
                            return null;
                        };

                        // Locate the account row by its visible account-id text.
                        const accountRows = document.querySelectorAll('tr[aria-level="1"]');
                        let targetRow = null;
                        for (const row of accountRows) {
                            const idEl = row.querySelector('[data-testid="account-federation-link"]');
                            if (idEl && idEl.textContent.trim() === account_id) {
                                targetRow = row;
                                break;
                            }
                        }
                        if (!targetRow) {
                            return { ok: false, error: 'account row not found for id ' + account_id };
                        }

                        // Expand the account if collapsed so the role link exists in the DOM.
                        const toggle = targetRow.querySelector('button[aria-expanded]');
                        if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
                            toggle.click();
                            for (let i = 0; i < 20; i++) {
                                await sleep(100);
                                if (toggle.getAttribute('aria-expanded') === 'true') break;
                            }
                            await sleep(200);
                        }

                        // Find the federation link matching account_id + role_name.
                        const links = document.querySelectorAll('a[data-testid="federation-link"]');
                        for (const link of links) {
                            const href = link.getAttribute('href') || '';
                            if (href.includes('account_id=' + account_id) && href.includes('role_name=' + account_role)) {
                                link.removeAttribute('target');
                                link.removeAttribute('rel');
                                link.click();
                                return { ok: true };
                            }
                        }
                        return { ok: false, error: 'role link not found for ' + account_id + '/' + account_role };
                    },
                    args: [account_id, account_role]
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
        var items = result.accounts;
        if (items.length === 0) {return}
        var allKeys = Object.keys(items);
        var currentDate = Math.floor(Date.now() / 1000);
        for (let i = 0; i < allKeys.length; i++) {
            var account = allKeys[i];
            var expirationDate = items[account].expirationDate;
            var status = items[account].status;
            if (status === "expired") {
                continue;
            }
            if (expirationDate < currentDate) {
                result["accounts"][account].status = "expired";
                chrome.storage.local.set(result);
            }
        }
    });
}

chrome.runtime.onMessage.addListener( function(request, _sender, _sendResponse) {
    debugLog('Background received message:', request);
    
    if (request.method === "changeAccount") {
        debugLog('Processing changeAccount for:', request.account);
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
        safeSendMessage({"method": "UpdateAccountsStatus"});
        chrome.storage.local.get(["accounts"], function(result){
            debugLog('Loaded accounts from storage:', result.accounts);

            if (result.accounts === undefined) {
                console.error('No accounts found in storage');
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            if (result.accounts[request.account] === undefined) {
                console.error('Account not found:', request.account, 'Available accounts:', Object.keys(result.accounts));
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + request.account}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            
            const accountData = result.accounts[request.account];
            debugLog('Account data for', request.account, ':', accountData);
            
            if (accountData.status === "expired") {
                debugLog('Account is expired, attempting login...');
                login(request.account, refresh_all_aws_tabs);
            } else {
                debugLog('Account is ready, changing account...');
                change_account(request.account);
            }
        });
    }
    else if (request.method === "loginOkta") {
        okta_login();
    }
    else if (request.method === "getAllAccounts") {
        get_all_accounts();
    }
    else if (request.method === "loadOktaApps") {
        loadOktaApps();
    }
    else if (request.method === "expireAccount") {
        // Clear AWS cookies to log out and expire the account
        debugLog('Expiring account:', request.account);
        chrome.cookies.getAll({"domain": ".amazon.com"}, function(cookies_to_remove) {
            removeAwsCookies(cookies_to_remove);
            
            // Update account status to expired
            chrome.storage.local.get(["accounts"], function(result) {
                if (result.accounts && result.accounts[request.account]) {
                    result.accounts[request.account].status = "expired";
                    chrome.storage.local.set(result, function() {
                        debugLog('Account expired and cookies cleared:', request.account);
                        safeSendMessage({"method": "UpdatePopup"});
                    });
                }
            });
        });
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

function aws_login(callback) {
    debugLog('aws_login function called');
    
    // Clear existing AWS cookies to prevent old session interference
    debugLog('Clearing existing AWS cookies...');
    chrome.cookies.getAll({"domain": ".amazon.com"}, function(cookies_to_remove) {
        removeAwsCookies(cookies_to_remove);
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
            if (storage.settings.aws_app === undefined) {
                // Try to auto-detect by running the Okta login flow if credentials are stored.
                if (storage.settings.okta_username && storage.settings.okta_password) {
                    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Detecting AWS app via Okta login..."}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    okta_login(() => {}, null);
                    return;
                }
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "AWS app not set. Click Login first to auto-detect, or use 'edit' next to AWS App URL to paste it manually."}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            var aws_saml_url = storage.settings.aws_app.url;
            //Check okta login
            const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs";
            fetch(list_apps_url, {
                method: 'GET',
                credentials: 'include'
            }).then(response => {
                if (!response.ok) {
                    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing okta login"}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    okta_login(aws_login, callback);
                    return;
                }
                chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Opening AWS login page"}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
                var flow_mode = storage.settings.aws_flow_mode || "access_portal";
                chrome.tabs.create({"url": aws_saml_url, "selected": false}, function(tab) {
                    if (checkLastError('tabs.create aws_saml_url') || !tab) {
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Failed to create AWS login tab"}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    var signin_timer = setInterval(wait_signin, 1000);
                    function wait_signin(){
                        chrome.scripting.executeScript({
                            target: {tabId: tab.id},
                            func: (mode) => {
                                if (mode === "access_portal") {
                                    const m = window.location.href.match(/^https:\/\/([^\/]+\.awsapps\.com)\/start/);
                                    if (!m) {
                                        return { ready: false, url: window.location.href };
                                    }
                                    return { ready: true, url: window.location.href, portalHost: m[1] };
                                }
                                // Classic SAML
                                if (window.location.href !== "https://signin.aws.amazon.com/saml") {
                                    return { ready: false, url: window.location.href };
                                }
                                const accountContainers = document.querySelectorAll('.saml-account');
                                const signinButton = document.getElementById('signin_button');
                                const ready = accountContainers.length > 0 && signinButton !== null;
                                return {
                                    ready: ready,
                                    url: window.location.href,
                                    accountCount: accountContainers.length,
                                    hasSigninButton: signinButton !== null
                                };
                            },
                            args: [flow_mode]
                        }).then((results) => {
                            const result = results[0].result;
                            if (!result || !result.ready) {
                                debugLog("AWS login page not ready yet:", result);
                                return;
                            }
                            if (flow_mode === "access_portal") {
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
                                    clearInterval(signin_timer);
                                    setTimeout(() => callback(tab.id, result.portalHost), 500);
                                }).catch((error) => {
                                    debugLog("Portal probe error:", error.message);
                                });
                                return;
                            }
                            debugLog("SAML page ready with", result.accountCount, "accounts");
                            clearInterval(signin_timer);
                            setTimeout(() => callback(tab.id), 500);
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

function okta_login(callback, callback_argument = null) {
    // Store current active tab to return to later and reset tab switching flag
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const originalTab = tabs[0];
        chrome.storage.local.set({
            "originalTab": {id: originalTab.id, url: originalTab.url},
            "hasReturnedToOriginalTab": false,  // Reset for new login session
            "appsAlreadyLoading": false  // Reset app loading flag
        });
        
        chrome.storage.local.get(["settings"], function(storage){
            chrome.storage.local.set({"login_status": {"status": "progress", "message": "Starting seamless login..."}});
            safeSendMessage({"method": "UpdateLoginStatus"});

            // Set badge to show login in progress
            chrome.action.setBadgeText({text: "..."});
            chrome.action.setBadgeBackgroundColor({color: "#2196F3"});

            if (storage.settings === undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! No settings found"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_domain === undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA domain not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_username === undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA username not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_password === undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA password not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        var domain = storage.settings.okta_domain;
        var username = storage.settings.okta_username;
        var storedPassword = storage.settings.okta_password;

        // Decrypt password if it's encrypted
        (async () => {
            let password = storedPassword;
            if (typeof CryptoUtils !== 'undefined' && CryptoUtils.isEncrypted(storedPassword)) {
                const decrypted = await CryptoUtils.decryptPassword(storedPassword, domain);
                if (decrypted) {
                    password = decrypted;
                } else {
                    chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! Could not decrypt password"}});
                    safeSendMessage({"method": "UpdateLoginStatus"});
                    return;
                }
            }
        
        // Go to root domain and wait for OAuth2 flow to present login fields
        const okta_url = "https://" + domain + "/";
        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Starting OAuth2 flow..."}});
        safeSendMessage({"method": "UpdateLoginStatus"});

        // First try to find an existing Okta tab
        chrome.tabs.query({url: "*://" + domain + "/*"}, function(existingTabs) {
            checkLastError('tabs.query okta domain');
            if (existingTabs && existingTabs.length > 0) {
                // Use existing tab but make it background
                chrome.tabs.update(existingTabs[0].id, {url: okta_url, active: false}, function(tab) {
                    if (checkLastError('tabs.update okta') || !tab) {
                        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Failed to update Okta tab"}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        return;
                    }
                    waitForOAuth2LoginFields(tab.id, callback, callback_argument, username, password);
                });
            } else {
                chrome.tabs.create({
                    "url": okta_url,
                    "active": false  // Keep in background initially to preserve popup
                }, function(tab) {
                    if (checkLastError('tabs.create okta') || !tab) {
                        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Failed to create Okta tab"}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        return;
                    }
                    waitForOAuth2LoginFields(tab.id, callback, callback_argument, username, password);
                });
            }
        });
        })(); // Close the async IIFE
    });
    }); // Close chrome.tabs.query callback
}

function handleLoginTab(tabId, callback, callback_argument, username, password, skipApiCheck = false) {
    
    // Wait for tab to load, then inject login script
    const login_timer = setInterval(function() {
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    func: () => document.readyState
                }).then((results) => {
                    if (results[0].result === 'complete') {
                        clearInterval(login_timer);
                        
                        // Update status to show we're checking authentication
                        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Checking authentication..."}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        
                        // Inject login credentials and submit
                        chrome.scripting.executeScript({
                            target: {tabId: tabId},
                            func: (username, password) => {
                                debugLog("SCRIPT INJECTION STARTED - VERY FIRST LINE");
                                try {
                                    debugLog("INSIDE TRY BLOCK");
                                    // ALWAYS run comprehensive page analysis FIRST - before any other code
                                    debugLog("=== COMPREHENSIVE PAGE ANALYSIS STARTING ===");
                                    debugLog("Login injection script starting");
                                    debugLog("Page URL:", window.location.href);
                                    debugLog("Page title:", document.title);
                                    debugLog("Document ready state:", document.readyState);
                                    debugLog("Body text preview:", document.body ? document.body.textContent.substring(0, 200) : 'NO BODY');
                                    
                                    
                                    // Don't assume login status from page content - always verify with actual login attempt
                                    // The API call validation will happen separately
                                    
                                    // SKIP the "already logged in" check - force complete login flow
                                    // This ensures we establish a proper Okta session that can access APIs
                                    debugLog("Forcing complete login flow to ensure proper session establishment");
                                    
                                    // Don't check for existing login - always proceed with credential injection
                                    // This will ensure we get a fresh, valid session
                                
                                // Check what's actually on this page to understand what we're dealing with
                                debugLog("=== DETAILED PAGE ANALYSIS ===");
                                debugLog("Page URL:", window.location.href);
                                debugLog("Page title:", document.title);
                                
                                // Log all elements on the page to see what we're missing
                                const allInputs = Array.from(document.querySelectorAll('input'));
                                const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
                                const allClickable = Array.from(document.querySelectorAll('*[onclick], button, input, a, [role="button"], [tabindex]'));
                                
                                debugLog("ALL INPUTS (" + allInputs.length + "):");
                                allInputs.forEach((inp, i) => {
                                    debugLog(`  ${i+1}. ${inp.tagName} - type:"${inp.type}" name:"${inp.name}" id:"${inp.id}" value:"${inp.value}" class:"${inp.className}"`);
                                });
                                
                                debugLog("ALL BUTTONS (" + allButtons.length + "):");
                                allButtons.forEach((btn, i) => {
                                    debugLog(`  ${i+1}. ${btn.tagName} - type:"${btn.type}" id:"${btn.id}" class:"${btn.className}" text:"${(btn.textContent || btn.value || '').substring(0,50)}"`);
                                });
                                
                                debugLog("ALL CLICKABLE (" + allClickable.length + "):");
                                allClickable.forEach((el, i) => {
                                    if (i < 10) { // Limit to first 10
                                        debugLog(`  ${i+1}. ${el.tagName} - id:"${el.id}" class:"${el.className}" text:"${(el.textContent || '').substring(0,50)}" href:"${el.href || ''}" onclick:"${el.onclick || ''}"`);
                                    }
                                });
                                
                                // If this is an OAuth2 page, maybe we need to click something to get to the login page
                                if (window.location.href.includes('/oauth2') || window.location.href.includes('/authorize')) {
                                    debugLog("This is an OAuth2 page - looking for elements that might take us to login");
                                    
                                    // Try to find any element that looks like it might proceed to login
                                    const potentialLoginTriggers = allClickable.filter(el => {
                                        const text = (el.textContent || el.value || '').toLowerCase();
                                        const className = (el.className || '').toLowerCase();
                                        const id = (el.id || '').toLowerCase();
                                        
                                        return text.includes('sign') || 
                                               text.includes('login') || 
                                               text.includes('continue') ||
                                               text.includes('proceed') ||
                                               className.includes('sign') ||
                                               className.includes('login') ||
                                               className.includes('continue') ||
                                               id.includes('sign') ||
                                               id.includes('login') ||
                                               id.includes('continue');
                                    });
                                    
                                    debugLog("POTENTIAL LOGIN TRIGGERS (" + potentialLoginTriggers.length + "):");
                                    potentialLoginTriggers.forEach((el, i) => {
                                        debugLog(`  ${i+1}. ${el.tagName} - "${(el.textContent || '').substring(0,30)}" class:"${el.className}" id:"${el.id}"`);
                                    });
                                    
                                    // If we found something that looks like a login trigger, click it
                                    if (potentialLoginTriggers.length > 0) {
                                        debugLog("Clicking potential login trigger:", potentialLoginTriggers[0].tagName, potentialLoginTriggers[0].textContent || potentialLoginTriggers[0].id);
                                        potentialLoginTriggers[0].click();
                                        
                                        return {
                                            success: false,
                                            message: 'Clicked potential login trigger, waiting for redirect...',
                                            pageTitle: document.title,
                                            url: window.location.href,
                                            clickedElement: potentialLoginTriggers[0].tagName + ' - ' + (potentialLoginTriggers[0].textContent || potentialLoginTriggers[0].id)
                                        };
                                    }
                                    
                                    // If no obvious triggers, try clicking any button or link
                                    if (allButtons.length > 0) {
                                        debugLog("No obvious login triggers, trying first button:", allButtons[0].textContent || allButtons[0].value);
                                        allButtons[0].click();
                                        return {
                                            success: false,
                                            message: 'Clicked first available button',
                                            pageTitle: document.title,
                                            url: window.location.href,
                                            clickedElement: allButtons[0].tagName
                                        };
                                    }
                                    
                                    // Try clicking any link that stays on the same domain
                                    const links = Array.from(document.querySelectorAll('a'));
                                    if (links.length > 0) {
                                        debugLog("ALL LINKS FOUND:");
                                        links.forEach((link, i) => {
                                            debugLog(`  ${i+1}. "${(link.textContent || '').substring(0,30)}" -> ${link.href}`);
                                        });
                                        
                                        // Filter for links that stay on the same domain and might be login-related
                                        const currentDomain = window.location.hostname;
                                        const loginLinks = links.filter(link => {
                                            const href = link.href || '';
                                            const text = (link.textContent || '').toLowerCase();
                                            
                                            // Must stay on same domain
                                            const linkDomain = new URL(href).hostname;
                                            const sameDomain = linkDomain === currentDomain;
                                            
                                            // Look for login-related terms
                                            const isLoginRelated = text.includes('sign') || text.includes('login') || 
                                                                   href.includes('sign') || href.includes('login') ||
                                                                   href.includes('/login') || href.includes('/signin');
                                            
                                            return sameDomain && isLoginRelated;
                                        });
                                        
                                        debugLog("SAME-DOMAIN LOGIN LINKS (" + loginLinks.length + "):");
                                        loginLinks.forEach((link, i) => {
                                            debugLog(`  ${i+1}. "${(link.textContent || '').substring(0,30)}" -> ${link.href}`);
                                        });
                                        
                                        if (loginLinks.length > 0) {
                                            debugLog("Clicking same-domain login link:", loginLinks[0].textContent, loginLinks[0].href);
                                            loginLinks[0].click();
                                            return {
                                                success: false,
                                                message: 'Clicked same-domain login link',
                                                pageTitle: document.title,
                                                url: window.location.href,
                                                clickedElement: 'Link: ' + loginLinks[0].href
                                            };
                                        }
                                        
                                        // If no login links on same domain, just try navigating directly to /login
                                        debugLog("No same-domain login links found, trying direct navigation to /login");
                                        const loginUrl = window.location.protocol + '//' + window.location.hostname + '/login/login.htm';
                                        debugLog("Navigating directly to:", loginUrl);
                                        window.location.href = loginUrl;
                                        
                                        return {
                                            success: false,
                                            message: 'No login links found - navigating directly to /login',
                                            pageTitle: document.title,
                                            url: window.location.href,
                                            navigatedTo: loginUrl
                                        };
                                    }
                                    
                                    debugLog("No interactive elements found on OAuth2 page that look like login triggers");
                                }
                                
                                // Try to find login elements with comprehensive selectors
                                let usernameField = null;
                                let passwordField = null;
                                let submitButton = null;
                                
                                // Always attempt login form detection and submission
                                debugLog("Attempting to find and submit login form...");
                                if (document.title.includes('Sign In') || 
                                    document.body.innerHTML.includes('sign') ||
                                    document.body.innerHTML.includes('login') ||
                                    document.body.innerHTML.includes('auth') ||
                                    document.querySelectorAll('input[type="password"]').length > 0 ||
                                    document.querySelectorAll('input[name="username"]').length > 0) {
                                    
                                    // Find login elements with comprehensive selectors
                                    usernameField = document.getElementById('okta-signin-username') ||
                                                       document.querySelector('input[name="username"]') ||
                                                       document.querySelector('input[name="identifier"]') ||
                                                       document.querySelector('input[type="email"]') ||
                                                       document.querySelector('input[type="text"]') ||
                                                       document.querySelector('input[autocomplete="username"]') ||
                                                       document.querySelector('input[autocomplete="email"]') ||
                                                       document.querySelector('input[placeholder*="username" i]') ||
                                                       document.querySelector('input[placeholder*="email" i]') ||
                                                       document.querySelector('input[data-se="o-form-input-username"]') ||
                                                       document.querySelector('#username') ||
                                                       document.querySelector('.username input') ||
                                                       document.querySelector('[data-testid="username"]');
                                    
                                    passwordField = document.getElementById('okta-signin-password') ||
                                                       document.querySelector('input[name="password"]') ||
                                                       document.querySelector('input[type="password"]') ||
                                                       document.querySelector('input[data-se="o-form-input-password"]') ||
                                                       document.querySelector('#password') ||
                                                       document.querySelector('.password input') ||
                                                       document.querySelector('[data-testid="password"]');
                                    
                                    submitButton = document.getElementById('okta-signin-submit') ||
                                                      document.querySelector('input[type="submit"]') ||
                                                      document.querySelector('button[type="submit"]') ||
                                                      document.querySelector('.okta-form-submit-button') ||
                                                      document.querySelector('button.btn-primary') ||
                                                      document.querySelector('button[data-type="save"]') ||
                                                      document.querySelector('[data-se="save"]') ||
                                                      document.querySelector('.login-button') ||
                                                      document.querySelector('.signin-button') ||
                                                      document.querySelector('input[value*="Sign"]') ||
                                                      document.querySelector('[data-testid="signin-submit"]') ||
                                                      Array.from(document.querySelectorAll('button')).find(btn => 
                                                          btn.textContent.includes('Sign In') || 
                                                          btn.textContent.includes('Login') ||
                                                          btn.textContent.includes('Sign in') ||
                                                          btn.textContent.includes('SIGN IN')) ||
                                                      Array.from(document.querySelectorAll('input')).find(inp => 
                                                          inp.value.includes('Sign') || 
                                                          inp.value.includes('Login'));
                                    debugLog("Login form search results:");
                                    // Username field detection completed
                                    // Password field detection completed
                                    debugLog("Submit button found:", !!submitButton, submitButton?.tagName, submitButton?.id, submitButton?.className);
                                    
                                    if (usernameField && passwordField && submitButton) {
                                        debugLog("Filling login form and submitting");
                                        usernameField.value = username;
                                        passwordField.value = password;
                                        
                                        // Trigger events
                                        usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                                        usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                                        passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                                        passwordField.dispatchEvent(new Event('change', {bubbles: true}));
                                        
                                        setTimeout(() => submitButton.click(), 100);
                                        return { success: true, message: 'Login form submitted successfully' };
                                    } else {
                                        // Enhanced fallback - try to use any available inputs
                                        debugLog("Primary selectors failed, trying enhanced fallback...");
                                        
                                        // Try any text-like input for username if not found
                                        if (!usernameField) {
                                            usernameField = allInputs.find(inp => 
                                                inp.type === 'text' || 
                                                inp.type === 'email' || 
                                                inp.type === '' ||
                                                inp.name?.toLowerCase().includes('user') ||
                                                inp.id?.toLowerCase().includes('user') ||
                                                inp.placeholder?.toLowerCase().includes('user') ||
                                                inp.placeholder?.toLowerCase().includes('email')
                                            );
                                            // Fallback username field search completed
                                        }
                                        
                                        // Try any password input if not found
                                        if (!passwordField) {
                                            passwordField = allInputs.find(inp => inp.type === 'password');
                                            // Fallback password field search completed
                                        }
                                        
                                        // Try any button for submit if not found
                                        if (!submitButton) {
                                            submitButton = allButtons.find(btn => 
                                                btn.type === 'submit' ||
                                                btn.textContent?.toLowerCase().includes('sign') ||
                                                btn.textContent?.toLowerCase().includes('login') ||
                                                btn.value?.toLowerCase().includes('sign') ||
                                                btn.value?.toLowerCase().includes('login')
                                            ) || allButtons[0]; // Use first button as last resort
                                            debugLog("Fallback submit button:", submitButton ? {tag: submitButton.tagName, type: submitButton.type, text: submitButton.textContent?.substring(0,30)} : 'none');
                                        }
                                        
                                        if (usernameField && passwordField && submitButton) {
                                            debugLog("Using fallback fields for login");
                                            usernameField.value = username;
                                            passwordField.value = password;
                                            
                                            usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                                            usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                                            passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                                            passwordField.dispatchEvent(new Event('change', {bubbles: true}));
                                            
                                            setTimeout(() => submitButton.click(), 100);
                                            return { success: true, message: 'Login form submitted using enhanced fallback' };
                                        }
                                    }
                                } else {
                                    debugLog("Page doesn't look like a typical login page, but trying to find login fields anyway...");
                                }
                                
                                // Always try to find login fields as a last resort, regardless of page detection
                                debugLog("Final attempt: searching for any login fields on page...");
                                if (!usernameField && !passwordField) {
                                    usernameField = document.querySelector('input[type="text"]') || 
                                                   document.querySelector('input[type="email"]') ||
                                                   document.querySelector('input[name*="user"]') ||
                                                   document.querySelector('input[id*="user"]');
                                    
                                    passwordField = document.querySelector('input[type="password"]');
                                    
                                    submitButton = document.querySelector('button[type="submit"]') ||
                                                  document.querySelector('input[type="submit"]') ||
                                                  document.querySelector('button');
                                    
                                    if (usernameField && passwordField && submitButton) {
                                        debugLog("Found login fields in final attempt - submitting");
                                        usernameField.value = username;
                                        passwordField.value = password;
                                        
                                        usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                                        usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                                        passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                                        passwordField.dispatchEvent(new Event('change', {bubbles: true}));
                                        
                                        setTimeout(() => submitButton.click(), 100);
                                        return { success: true, message: 'Login form submitted (final attempt)' };
                                    }
                                }
                                
                                return { 
                                    success: false, 
                                    message: 'Could not find or submit login form',
                                    pageTitle: document.title,
                                    url: window.location.href,
                                    foundUsername: !!usernameField,
                                    foundPassword: !!passwordField,
                                    foundSubmit: !!submitButton,
                                    // Add analysis details to see what's actually on the page
                                    analysis: {
                                        totalInputs: allInputs.length,
                                        totalButtons: allButtons.length,
                                        totalForms: document.querySelectorAll('form').length,
                                        bodyPreview: document.body ? document.body.textContent.substring(0, 200) : 'NO BODY',
                                        isOAuth2Page: window.location.href.includes('/oauth2') || window.location.href.includes('/authorize'),
                                        hasPasswordInput: document.querySelectorAll('input[type="password"]').length > 0,
                                        hasUsernameInput: document.querySelectorAll('input[name="username"], input[type="email"], input[type="text"]').length > 0,
                                        clickableElements: Array.from(document.querySelectorAll('*[onclick], button, input, a, [role="button"]')).length
                                    }
                                };
                                } catch (error) {
                                    debugLog("CAUGHT ERROR IN SCRIPT:", error);
                                    debugLog("Error message:", error.message);
                                    debugLog("Error stack:", error.stack);
                                    return {
                                        success: false,
                                        message: 'Script error: ' + error.message,
                                        pageTitle: document.title,
                                        url: window.location.href
                                    };
                                }
                            },
                            args: [username, password]
                        }).then((results) => {
                            debugLog("Login injection raw results:", results);
                            
                            if (!results || results.length === 0) {
                                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login script returned no results"}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                chrome.tabs.remove(tabId);
                                return;
                            }
                            
                            const result = results[0]?.result;
                            debugLog("Login injection result:", result);
                            
                            // Log detailed analysis if available
                            if (result?.analysis) {
                                debugLog("=== PAGE ANALYSIS SUMMARY ===");
                                debugLog("Page title:", result.pageTitle || 'EMPTY');
                                debugLog("URL:", result.url || 'UNKNOWN');
                                debugLog("Is OAuth2 page:", result.analysis.isOAuth2Page);
                                debugLog("Total inputs:", result.analysis.totalInputs);
                                debugLog("Total buttons:", result.analysis.totalButtons);
                                debugLog("Total forms:", result.analysis.totalForms);
                                // Login form analysis completed
                                debugLog("Clickable elements:", result.analysis.clickableElements);
                                debugLog("Body preview:", result.analysis.bodyPreview);
                                debugLog("=== END ANALYSIS ===");
                                
                                // Check if we're already on an authenticated dashboard page
                                if (result.url && (result.url.includes('/app/UserHome') || result.url.includes('session_hint=AUTHENTICATED'))) {
                                    debugLog("🎉 Already authenticated and on dashboard! Skipping login and loading applications directly.");
                                    chrome.storage.local.set({"oauth2LoginCompleted": true}); // Mark login as completed
                                    chrome.storage.local.set({"login_status": {"status": "success", "message": "Already logged in - loading applications..."}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Since the tab keeps reverting to OAuth2, try direct service worker API call
                                    chrome.storage.local.get(["settings"], function(storage){
                                        if (storage.settings && storage.settings.okta_domain) {
                                            const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                                            
                                            // Try direct fetch from service worker first
                                            fetch(list_apps_url, {
                                                method: 'GET',
                                                credentials: 'include',
                                                headers: {
                                                    'Accept': 'application/json',
                                                    'Content-Type': 'application/json'
                                                }
                                            }).then(response => {
                                                if (response.ok) {
                                                    return response.json().then(okta_tabs => {
                                                        chrome.storage.local.set({"okta_apps_status": {"status": "success", "apps": okta_tabs}});
                                                        safeSendMessage({"method": "UpdateOktaApps"});
                                                        chrome.tabs.remove(tabId); // Close the problematic tab
                                                        
                                                        if (callback) {
                                                            callback(callback_argument);
                                                        }
                                                    });
                                                } else {
                                                    debugLog("Service worker API failed, falling back to tab-based approach");
                                                    // Fall back to tab-based approach as last resort
                                                    setTimeout(() => {
                                                        makeOktaApiCall(tabId, list_apps_url, true);
                                                    }, 2000);
                                                }
                                            }).catch(error => {
                                                debugLog("Service worker API error:", error.message, "- falling back to tab approach");
                                                // Fall back to tab-based approach
                                                setTimeout(() => {
                                                    makeOktaApiCall(tabId, list_apps_url, true);
                                                }, 2000);
                                            });
                                        }
                                    });
                                    return; // Skip the rest of the login logic
                                }
                            }
                            
                            if (!result) {
                                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login script execution failed - no result object"}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                chrome.tabs.remove(tabId);
                                return;
                            }
                            
                            if (result.isOAuth2) {
                                // We're on an OAuth2 page - start monitoring immediately for login fields
                                debugLog("Detected OAuth2 page - monitoring for login fields to inject credentials");
                                chrome.storage.local.set({"login_status": {"status": "progress", "message": "Looking for login fields on page..."}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                
                                // Start monitoring immediately - no delays
                                monitorOktaLogin(tabId, callback, callback_argument);
                            } else if (result.success) {
                                if (result.alreadyLoggedIn && !skipApiCheck) {
                                    // Verify API access before claiming success
                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Verifying API access..."}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Test API access from within the tab context
                                    chrome.storage.local.get(["settings"], function(storage){
                                        if (storage.settings && storage.settings.okta_domain) {
                                            const test_api_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs";
                                            
                                            // Test API access from within the tab
                                            chrome.scripting.executeScript({
                                                target: {tabId: tabId},
                                                func: (apiUrl) => {
                                                    debugLog("Testing API access to:", apiUrl);
                                                    debugLog("Current page URL:", window.location.href);
                                                    return fetch(apiUrl, {
                                                        method: 'GET',
                                                        credentials: 'include'
                                                    }).then(response => {
                                                        debugLog("API test response status:", response.status);
                                                        return {
                                                            success: response.ok,
                                                            status: response.status,
                                                            url: window.location.href,
                                                            title: document.title
                                                        };
                                                    }).catch(error => {
                                                        debugLog("API test error:", error.message);
                                                        return {
                                                            success: false,
                                                            error: error.message,
                                                            url: window.location.href,
                                                            title: document.title
                                                        };
                                                    });
                                                },
                                                args: [test_api_url]
                                            }).then((results) => {
                                                const apiResult = results[0].result;
                                                if (apiResult.success) {
                                                    // API access works - truly logged in
                                                    chrome.storage.local.set({"oauth2LoginCompleted": true}); // Mark login as completed
                                                    chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                                    
                                                    // Navigate to dashboard to get proper session before loading apps
                                                    const dashboardUrl = "https://" + storage.settings.okta_domain + "/app/UserHome";
                                                    debugLog("Navigating to dashboard for proper session:", dashboardUrl);
                                                    
                                                    chrome.tabs.update(tabId, {url: dashboardUrl}, function() {
                                                        debugLog("Tab navigation initiated, waiting for dashboard to load...");
                                                        // Use navigation verification instead of fixed timeout
                                                        waitForTabNavigation(tabId, dashboardUrl, function(success) {
                                                            if (success) {
                                                                debugLog("Dashboard navigation confirmed, establishing session...");
                                                                // Refresh the dashboard page to ensure session is fully established
                                                                chrome.tabs.reload(tabId, function() {
                                                                    debugLog("Dashboard page refreshed, waiting for session establishment...");
                                                                    // Wait longer for session to be fully established
                                                                    setTimeout(() => {
                                                                        debugLog("Session establishment complete, auto-loading applications (API verification path)");
                                                                        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                                                                        makeOktaApiCall(tabId, list_apps_url, true); // closeTab = true after apps loaded
                                                                    }, 5000); // Increased wait time to 5 seconds
                                                                });
                                                            } else {
                                                                debugLog("Dashboard navigation failed, closing tab");
                                                                chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "Failed to navigate to dashboard for app loading"}});
                                                                safeSendMessage({"method": "UpdateOktaApps"});
                                                                chrome.tabs.remove(tabId);
                                                            }
                                                        });
                                                    });
                                                    
                                                    if (callback) {
                                                        callback(callback_argument);
                                                    }
                                                } else {
                                                    // API access failed - need to actually log in
                                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Session expired, logging in..."}});
                                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                                    
                                                    // Continue with normal login flow by restarting the login process
                                                    chrome.tabs.update(tabId, {url: "https://" + storage.settings.okta_domain + "/"}, function() {
                                                        // Wait a bit then retry login with API check disabled
                                                        setTimeout(async () => {
                                                            const password = await getDecryptedPassword(storage.settings.okta_password, storage.settings.okta_domain);
                                                            handleLoginTab(tabId, callback, callback_argument, storage.settings.okta_username, password, true);
                                                        }, 2000);
                                                    });
                                                }
                                            }).catch(error => {
                                                // API test script injection failed - try normal login
                                                chrome.storage.local.set({"login_status": {"status": "progress", "message": "API test failed, retrying login..."}});
                                                try {
                                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                                } catch (e) {
                                                    debugLog("Popup not open, continuing in background");
                                                }
                                                
                                                // Continue with normal login flow
                                                chrome.tabs.update(tabId, {url: "https://" + storage.settings.okta_domain + "/"}, function() {
                                                    setTimeout(async () => {
                                                        const password = await getDecryptedPassword(storage.settings.okta_password, storage.settings.okta_domain);
                                                        handleLoginTab(tabId, callback, callback_argument, storage.settings.okta_username, password, true);
                                                    }, 2000);
                                                });
                                            });
                                        } else {
                                            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Settings not found"}});
                                            safeSendMessage({"method": "UpdateLoginStatus"});
                                            chrome.tabs.remove(tabId);
                                        }
                                    });
                                } else if (result.alreadyLoggedIn && skipApiCheck) {
                                    // Skip API check this time and assume success
                                    chrome.storage.local.set({"oauth2LoginCompleted": true}); // Mark login as completed
                                    chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Navigate to dashboard to get proper session before loading apps
                                    chrome.storage.local.get(["settings"], function(storage){
                                        if (storage.settings && storage.settings.okta_domain) {
                                            const dashboardUrl = "https://" + storage.settings.okta_domain + "/app/UserHome";
                                            debugLog("Navigating to dashboard for proper session:", dashboardUrl);
                                            
                                            chrome.tabs.update(tabId, {url: dashboardUrl}, function() {
                                                debugLog("Tab navigation initiated, waiting for dashboard to load...");
                                                // Use navigation verification instead of fixed timeout
                                                waitForTabNavigation(tabId, dashboardUrl, function(success) {
                                                    if (success) {
                                                        debugLog("Dashboard navigation confirmed, establishing session...");
                                                        // Refresh the dashboard page to ensure session is fully established
                                                        chrome.tabs.reload(tabId, function() {
                                                            debugLog("Dashboard page refreshed, waiting for session establishment...");
                                                            // Wait longer for session to be fully established
                                                            setTimeout(() => {
                                                                debugLog("Session establishment complete, auto-loading applications (skipApiCheck path)");
                                                                const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                                                                makeOktaApiCall(tabId, list_apps_url, true); // closeTab = true after apps loaded
                                                            }, 5000); // Increased wait time to 5 seconds
                                                        });
                                                    } else {
                                                        debugLog("Dashboard navigation failed, closing tab");
                                                        chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "Failed to navigate to dashboard for app loading"}});
                                                        safeSendMessage({"method": "UpdateOktaApps"});
                                                        chrome.tabs.remove(tabId);
                                                    }
                                                });
                                            });
                                        } else {
                                            chrome.tabs.remove(tabId);
                                        }
                                        
                                        if (callback) {
                                            callback(callback_argument);
                                        }
                                    });
                                } else {
                                    // Login form was submitted
                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Logging in to Okta..."}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Monitor for login completion or MFA
                                    monitorOktaLogin(tabId, callback, callback_argument);
                                }
                            } else {
                                // Check if we navigated to a new page - if so, start monitoring
                                if (result.navigatedTo) {
                                    debugLog("Navigated to new page, starting monitoring:", result.navigatedTo);
                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Navigated to login page, looking for login fields..."}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Wait for navigation to complete then start monitoring
                                    setTimeout(() => {
                                        debugLog("Starting monitoring after navigation");
                                        monitorOktaLogin(tabId, callback, callback_argument);
                                    }, 3000);
                                } else {
                                    chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login form not found: " + result.message}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    chrome.tabs.remove(tabId);
                                }
                            }
                        }).catch(error => {
                            // Login injection failed
                            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login injection failed: " + error.message}});
                            safeSendMessage({"method": "UpdateLoginStatus"});
                            chrome.tabs.remove(tabId);
                        });
                    }
                }).catch(error => {
                    // Tab readiness check failed
                    clearInterval(login_timer);
                    chrome.storage.local.set({"login_status": {"status": "failed", "message": "Tab loading failed: " + error.message}});
                    safeSendMessage({"method": "UpdateLoginStatus"});
                    chrome.tabs.remove(tabId);
                });
            }, 1000);
}

function waitForTabNavigation(tabId, _expectedUrl, callback) {
    let attempts = 0;
    const maxAttempts = 15; // 15 seconds total wait time
    
    const checkNavigation = setInterval(function() {
        attempts++;
        
        chrome.tabs.get(tabId, function(tab) {
            if (chrome.runtime.lastError) {
                debugLog("Tab no longer exists during navigation wait");
                clearInterval(checkNavigation);
                callback(false);
                return;
            }
            
            debugLog(`Navigation check ${attempts}/${maxAttempts}: Current URL: ${tab.url}`);
            
            // Check if we've successfully navigated to the expected URL or a related dashboard URL
            if (tab.url.includes('/app/UserHome') || tab.url.includes('/dashboard') || tab.url.includes('/user/profile')) {
                debugLog("Successfully navigated to dashboard-like page");
                clearInterval(checkNavigation);
                callback(true);
                return;
            }
            
            // If we've waited long enough, give up
            if (attempts >= maxAttempts) {
                debugLog("Navigation timeout - giving up");
                clearInterval(checkNavigation);
                callback(false);
                return;
            }
        });
    }, 1000);
}

function monitorOktaLogin(tabId, callback, callback_argument) {
    let monitorCount = 0;
    
    const monitor_timer = setInterval(function() {
        monitorCount++;
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: () => {
                // Simple check: look for login fields and inject credentials immediately
                const url = window.location.href;
                const title = document.title;
                
                // Look for username field
                const hasUsernameField = !!(document.getElementById('okta-signin-username') ||
                                           document.querySelector('input[name="username"]') ||
                                           document.querySelector('input[name="identifier"]') ||
                                           document.querySelector('input[type="email"]') ||
                                           document.querySelector('input[type="text"]'));
                
                // Look for password field
                const hasPasswordField = !!(document.getElementById('okta-signin-password') ||
                                           document.querySelector('input[name="password"]') ||
                                           document.querySelector('input[type="password"]'));
                
                // Check for MFA challenge
                const mfaElement = document.querySelector('[data-se="factor-push"]') || 
                                 document.querySelector('.okta-verify-challenge') ||
                                 document.querySelector('[data-se="mfa-verify-passcode"]');
                
                // Check for successful login (dashboard)
                const isLoggedIn = (url.includes('/app/') || 
                                  url.includes('/dashboard') || 
                                  url.includes('/user/profile') ||
                                  title.includes('Dashboard') ||
                                  document.querySelector('.okta-dashboard')) &&
                                  !url.includes('/oauth2') &&
                                  !url.includes('/authorize') &&
                                  !url.includes('/callback');
                
                // Check for login error
                const errorElement = document.querySelector('.okta-form-infobox-error') ||
                                   document.querySelector('[data-se="errors-container"]') ||
                                   document.querySelector('.error-16');
                
                return {
                    url: url,
                    title: title,
                    hasUsernameField: hasUsernameField,
                    hasPasswordField: hasPasswordField,
                    hasMFA: !!mfaElement,
                    isLoggedIn: isLoggedIn,
                    hasError: !!errorElement,
                    errorText: errorElement ? errorElement.textContent : null
                };
            }
        }).then((results) => {
            const state = results[0].result;
            debugLog(`Monitoring state (attempt ${monitorCount}):`, state);
            
            // Add debugging every few attempts to see what's on the page
            if (monitorCount % 5 === 1) {
                debugLog(`=== DEBUG: What's on the page (attempt ${monitorCount}) ===`);
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    func: () => {
                        const inputs = Array.from(document.querySelectorAll('input'));
                        const buttons = Array.from(document.querySelectorAll('button'));
                        
                        return {
                            url: window.location.href,
                            title: document.title,
                            inputs: inputs.map(inp => ({
                                type: inp.type,
                                name: inp.name,
                                id: inp.id,
                                placeholder: inp.placeholder,
                                value: inp.value,
                                className: inp.className
                            })),
                            buttons: buttons.map(btn => ({
                                type: btn.type,
                                id: btn.id,
                                text: btn.textContent?.substring(0, 30)
                            })),
                            bodyPreview: document.body?.textContent?.substring(0, 100),
                            forms: Array.from(document.querySelectorAll('form')).map(form => ({
                                id: form.id,
                                action: form.action,
                                method: form.method,
                                innerHTML: form.innerHTML.substring(0, 200)
                            })),
                            allElements: Array.from(document.querySelectorAll('*[type="text"], *[type="email"], *[type="password"], *[name*="user"], *[name*="email"], *[name*="pass"]')).map(el => ({
                                tagName: el.tagName,
                                type: el.type,
                                name: el.name,
                                id: el.id,
                                placeholder: el.placeholder
                            }))
                        };
                    }
                }).then((debugResults) => {
                    const debug = debugResults[0].result;
                    debugLog(`Page URL: ${debug.url}`);
                    debugLog(`Page Title: ${debug.title}`);
                    debugLog(`Body Preview: ${debug.bodyPreview}`);
                    debugLog(`Inputs (${debug.inputs.length}):`, debug.inputs);
                    debugLog(`Buttons (${debug.buttons.length}):`, debug.buttons);
                    debugLog(`Forms (${debug.forms.length}):`, debug.forms);
                    debugLog(`All login-related elements (${debug.allElements.length}):`, debug.allElements);
                }).catch(err => debugLog("Debug failed:", err.message));
            }
            
            // If we find login fields, inject credentials immediately
            if (state.hasUsernameField && state.hasPasswordField) {
                debugLog("Login fields found - injecting credentials immediately");
                clearInterval(monitor_timer);
                
                chrome.storage.local.set({"login_status": {"status": "progress", "message": "Auto-filling login credentials..."}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                
                chrome.storage.local.get(["settings"], async function(storage){
                    if (storage.settings && storage.settings.okta_username && storage.settings.okta_password) {
                        const password = await getDecryptedPassword(storage.settings.okta_password, storage.settings.okta_domain);
                        chrome.scripting.executeScript({
                            target: {tabId: tabId},
                            func: (username, password) => {
                                debugLog("Injecting credentials on page:", window.location.href);

                                // Find fields
                                const usernameField = document.getElementById('okta-signin-username') ||
                                                     document.querySelector('input[name="username"]') ||
                                                     document.querySelector('input[name="identifier"]') ||
                                                     document.querySelector('input[type="email"]') ||
                                                     document.querySelector('input[type="text"]');

                                const passwordField = document.getElementById('okta-signin-password') ||
                                                     document.querySelector('input[name="password"]') ||
                                                     document.querySelector('input[type="password"]');

                                const submitButton = document.getElementById('okta-signin-submit') ||
                                                    document.querySelector('input[type="submit"]') ||
                                                    document.querySelector('button[type="submit"]') ||
                                                    document.querySelector('button');

                                if (usernameField && passwordField && submitButton) {
                                    debugLog("Filling and submitting login form");
                                    usernameField.value = username;
                                    passwordField.value = password;

                                    // Trigger events
                                    usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                                    usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                                    passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                                    passwordField.dispatchEvent(new Event('change', {bubbles: true}));

                                    // Submit
                                    setTimeout(() => submitButton.click(), 500);
                                    return { success: true };
                                }
                                return { success: false, message: 'Could not find all form fields' };
                            },
                            args: [storage.settings.okta_username, password]
                        }).then((results) => {
                            const fillResult = results[0].result;
                            if (fillResult.success) {
                                chrome.storage.local.set({"login_status": {"status": "progress", "message": "Credentials submitted, waiting for login..."}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                
                                // Continue monitoring for completion
                                setTimeout(() => {
                                    monitorOktaLogin(tabId, callback, callback_argument);
                                }, 2000);
                            } else {
                                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Failed to inject credentials: " + fillResult.message}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                chrome.tabs.remove(tabId);
                            }
                        }).catch(error => {
                            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Credential injection error: " + error.message}});
                            safeSendMessage({"method": "UpdateLoginStatus"});
                            chrome.tabs.remove(tabId);
                        });
                    } else {
                        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login credentials not configured"}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        chrome.tabs.remove(tabId);
                    }
                });
                return;
            }
            
            if (state.hasError) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed: " + state.errorText}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                chrome.tabs.remove(tabId);
            } else if (state.hasMFA) {
                chrome.storage.local.set({"login_status": {"status": "progress", "message": "MFA challenge detected. Please complete authentication."}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                // Continue monitoring for MFA completion
            } else if (state.isLoggedIn) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"oauth2LoginCompleted": true}); // Mark login as completed
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                safeSendMessage({"method": "UpdateLoginStatus"});

                // Login successful - apps will now load with final badge update
                
                // Show success notification
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'Icons/aws-logo.png',
                    title: 'AWS Account Switcher',
                    message: 'Login successful! Applications loading...'
                });
                
                // Original tab return is handled by credential injection logic
                
                // Load apps directly from current dashboard page (only once per session)
                chrome.storage.local.get(["settings", "appsAlreadyLoading"], function(storage){
                    if (storage.settings && storage.settings.okta_domain && !storage.appsAlreadyLoading) {
                        // Update badge to show apps loading
                        chrome.action.setBadgeText({text: "📱"});
                        chrome.action.setBadgeBackgroundColor({color: "#9C27B0"});
                        
                        // Set flag to prevent multiple loading attempts
                        chrome.storage.local.set({"appsAlreadyLoading": true});
                        
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
            clearInterval(monitor_timer);
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Monitoring failed: " + error.message}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            chrome.tabs.remove(tabId);
        });
    }, 1000); // Check every 1 second
    
    // Timeout after 30 seconds
    setTimeout(() => {
        clearInterval(monitor_timer);
        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login process timed out after 30 seconds"}});
        safeSendMessage({"method": "UpdateLoginStatus"});
        chrome.tabs.remove(tabId);
    }, 30000);
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

function waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth = 0) {
    // Prevent infinite recursion
    if (recursionDepth >= 5) {
        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login process took too long"}});
        safeSendMessage({"method": "UpdateLoginStatus"});
        chrome.tabs.remove(tabId);
        return;
    }

    // On first call (recursionDepth === 0), set up the login tracking flag
    // This flag is used to prevent the timeout from overwriting a successful login status
    if (recursionDepth === 0) {
        chrome.storage.local.set({"oauth2LoginCompleted": false});
    }

    // Store flag in Chrome storage to persist across recursive calls
    chrome.storage.local.get(["hasReturnedToOriginalTab"], function(result) {
        if (!result.hasReturnedToOriginalTab) {
            chrome.storage.local.set({"hasReturnedToOriginalTab": false});
        }
    });
    
    // Make tab active briefly so login form loads properly
    chrome.tabs.update(tabId, { active: true }, function() {
        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Loading login form..."}});
        safeSendMessage({"method": "UpdateLoginStatus"});
        
        // Tab will return to original after login fields are found and injected
    });
    
    let monitorCount = 0;
    
    // Give the page 2 seconds to detect tab activation and load forms
    setTimeout(() => {
        const monitor_timer = setInterval(function() {
            monitorCount++;
        
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: () => {
                const url = window.location.href;
                const title = document.title;
                
                // Wait for dynamic content to load
                const readyState = document.readyState;
                const bodyHTML = document.body ? document.body.innerHTML.length : 0;
                
                // Look for ANY form inputs that could be login fields
                const allInputs = Array.from(document.querySelectorAll('input'));
                const visibleInputs = allInputs.filter(inp => 
                    inp.style.display !== 'none' && 
                    inp.type !== 'hidden' &&
                    inp.offsetWidth > 0 && 
                    inp.offsetHeight > 0
                );
                
                // Enhanced search for login elements - check common OAuth2/Okta selectors
                let usernameField = visibleInputs.find(inp => 
                    inp.type === 'text' || 
                    inp.type === 'email' ||
                    inp.name?.toLowerCase().includes('user') ||
                    inp.name?.toLowerCase().includes('email') ||
                    inp.id?.toLowerCase().includes('user') ||
                    inp.id?.toLowerCase().includes('email') ||
                    inp.placeholder?.toLowerCase().includes('user') ||
                    inp.placeholder?.toLowerCase().includes('email') ||
                    inp.autocomplete?.toLowerCase().includes('user') ||
                    inp.autocomplete?.toLowerCase().includes('email')
                );
                
                // Also check for ANY visible text input if no username field found specifically
                if (!usernameField && visibleInputs.length > 0) {
                    usernameField = visibleInputs.find(inp => inp.type === 'text' || inp.type === 'email' || inp.type === '');
                }
                
                // Look for password fields
                const passwordField = visibleInputs.find(inp => inp.type === 'password');
                
                // Enhanced button search - look for more button types and text content
                const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a.btn'));
                const submitButtons = allButtons.filter(btn =>
                    btn.style.display !== 'none' && 
                    btn.offsetWidth > 0 && 
                    btn.offsetHeight > 0 &&
                    !btn.disabled
                );
                
                // Check if already logged in
                const isLoggedIn = (url.includes('/app/') || 
                                  url.includes('/dashboard') || 
                                  title.includes('Dashboard')) &&
                                  !url.includes('/oauth2');
                
                // Debug: Check for any interactive elements if no forms found
                const allInteractiveElements = Array.from(document.querySelectorAll('input, button, select, textarea, [role="button"], [onclick]'));
                const formsCount = document.querySelectorAll('form').length;
                const iframesCount = document.querySelectorAll('iframe').length;
                
                // Check if page is still loading content dynamically
                const hasSpinners = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="progress"]').length > 0;
                const hasScripts = document.querySelectorAll('script').length;
                
                return {
                    url: url,
                    title: title,
                    hasUsernameField: !!usernameField,
                    hasPasswordField: !!passwordField,
                    hasSubmitButton: submitButtons.length > 0,
                    isLoggedIn: isLoggedIn,
                    visibleInputsCount: visibleInputs.length,
                    buttonsCount: submitButtons.length,
                    // Debug info for dynamic content
                    readyState: readyState,
                    bodyHTMLLength: bodyHTML,
                    totalInteractiveElements: allInteractiveElements.length,
                    formsCount: formsCount,
                    iframesCount: iframesCount,
                    hasSpinners: hasSpinners,
                    scriptsCount: hasScripts,
                    // Sample of page content for debugging
                    bodyTextSample: document.body ? document.body.textContent.substring(0, 500) : 'NO BODY',
                    // Return the actual elements for injection if found
                    usernameSelector: usernameField ? getSelector(usernameField) : null,
                    passwordSelector: passwordField ? getSelector(passwordField) : null,
                    submitSelector: submitButtons.length > 0 ? getSelector(submitButtons[0]) : null
                };
                
                function getSelector(element) {
                    if (element.id) return '#' + element.id;
                    if (element.name) return '[name="' + element.name + '"]';
                    if (element.className) return '.' + element.className.split(' ')[0];
                    return element.tagName.toLowerCase();
                }
            }
        }).then((results) => {
            if (!results || results.length === 0 || !results[0] || results[0].result === null) {
                return; // Skip this attempt, tab is still loading
            }
            
            const state = results[0].result;
            
            // If already logged in, success
            if (state.isLoggedIn) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"oauth2LoginCompleted": true}); // Mark login as completed to prevent timeout from overwriting
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Already logged in!"}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                
                chrome.storage.local.get(["settings"], function(storage){
                    if (storage.settings && storage.settings.okta_domain) {
                        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                        makeOktaApiCall(tabId, list_apps_url, true);
                    }
                    if (callback) callback(callback_argument);
                });
                return;
            }
            
            // Check if this is an OAuth2 authorization page that needs to be clicked through
            if (state.url.includes('/oauth2/') && !state.hasUsernameField && !state.hasPasswordField && state.hasSubmitButton) {
                clearInterval(monitor_timer);
                
                // Try to click any authorization/continue button
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    func: () => {
                        // Look for common OAuth2 authorization buttons
                        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
                        const authButton = buttons.find(btn => 
                            btn.textContent?.toLowerCase().includes('continue') ||
                            btn.textContent?.toLowerCase().includes('authorize') ||
                            btn.textContent?.toLowerCase().includes('allow') ||
                            btn.textContent?.toLowerCase().includes('next') ||
                            btn.value?.toLowerCase().includes('continue') ||
                            btn.value?.toLowerCase().includes('authorize')
                        );
                        
                        if (authButton && authButton.offsetWidth > 0 && authButton.offsetHeight > 0) {
                            authButton.click();
                            return { success: true, buttonText: authButton.textContent || authButton.value };
                        }
                        
                        return { success: false, availableButtons: buttons.map(b => b.textContent || b.value).filter(t => t) };
                    }
                }).then((clickResults) => {
                    if (clickResults[0]?.result?.success) {
                        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Authorization clicked, waiting for login form..."}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        
                        // Continue monitoring after clicking authorization
                        setTimeout(() => {
                            waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth + 1);
                        }, 2000);
                    } else {
                        // Continue monitoring anyway
                        setTimeout(() => {
                            waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth + 1);
                        }, 3000);
                    }
                }).catch(error => {
                    // Continue monitoring anyway
                    setTimeout(() => {
                        waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth + 1);
                    }, 3000);
                });
                return;
            }
            
            // If we found login fields (prioritize username/password fields over just submit buttons)
            if (state.hasUsernameField || state.hasPasswordField) {
                clearInterval(monitor_timer);
                
                chrome.storage.local.set({"login_status": {"status": "progress", "message": "Auto-filling login credentials..."}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                
                // Update badge to show credentials being filled
                chrome.action.setBadgeText({text: "📝"});
                chrome.action.setBadgeBackgroundColor({color: "#FF9800"});
                
                // Return to original tab now that we found the form and are injecting (only once)
                chrome.storage.local.get(["hasReturnedToOriginalTab"], function(returnResult) {
                    if (!returnResult.hasReturnedToOriginalTab) {
                        chrome.storage.local.set({"hasReturnedToOriginalTab": true});
                        chrome.storage.local.get(["originalTab"], function(tabResult) {
                            if (tabResult.originalTab && tabResult.originalTab.id) {
                                setTimeout(() => {
                                    chrome.tabs.update(tabResult.originalTab.id, { active: true }).catch(() => {
                                        // Original tab may have been closed, that's OK
                                    });
                                }, 100); // Small delay to ensure credential injection starts
                            }
                        });
                    }
                });
                
                // Inject credentials
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    func: (username, password, userSel, passSel, submitSel) => {
                        
                        let filled = false;
                        let usernameField = null;
                        let passwordField = null;
                        let submitButton = null;
                        
                        // Get the actual fields
                        if (userSel) {
                            usernameField = document.querySelector(userSel);
                        }
                        if (passSel) {
                            passwordField = document.querySelector(passSel);
                        }
                        if (submitSel) {
                            submitButton = document.querySelector(submitSel);
                        }
                        
                        // Multi-step OAuth2 flow handling:
                        // Step 1: If only username field is present, fill it and click Next
                        if (usernameField && !passwordField) {
                            usernameField.value = username;
                            usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                            usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                            filled = true;
                            
                            if (submitButton) {
                                setTimeout(() => {
                                    submitButton.click();
                                }, 300);
                                return { success: true, action: 'username_submitted', step: 'username_next' };
                            }
                        }
                        // Step 2: If only password field is present, fill it and submit
                        else if (passwordField && !usernameField) {
                            passwordField.value = password;
                            passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                            passwordField.dispatchEvent(new Event('change', {bubbles: true}));
                            filled = true;
                            
                            if (submitButton) {
                                setTimeout(() => {
                                    submitButton.click();
                                }, 300);
                                return { success: true, action: 'password_submitted', step: 'login_complete' };
                            }
                        }
                        // Step 3: Both fields present - fill both and submit (single-step login)
                        else if (usernameField && passwordField) {
                            usernameField.value = username;
                            usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                            usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                            
                            passwordField.value = password;
                            passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                            passwordField.dispatchEvent(new Event('change', {bubbles: true}));
                            filled = true;
                            
                            if (submitButton) {
                                setTimeout(() => {
                                    submitButton.click();
                                }, 500);
                                return { success: true, action: 'both_submitted', step: 'login_complete' };
                            }
                        }
                        
                        return { 
                            success: filled, 
                            action: filled ? 'filled' : 'no_fields',
                            step: 'unknown',
                            foundUsername: !!usernameField,
                            foundPassword: !!passwordField,
                            foundSubmit: !!submitButton
                        };
                    },
                    args: [username, password, state.usernameSelector, state.passwordSelector, state.submitSelector]
                }).then((results) => {
                    if (!results || results.length === 0) {
                        return;
                    }
                    const result = results[0].result;
                    
                    if (result.success) {
                        // Provide step-specific status messages
                        let statusMessage = "Processing login...";
                        if (result.step === 'username_next') {
                            statusMessage = "Username submitted, waiting for password step...";
                        } else if (result.step === 'login_complete') {
                            statusMessage = "Login submitted, verifying authentication...";
                        } else if (result.action === 'both_submitted') {
                            statusMessage = "Credentials submitted, completing login...";
                        }
                        
                        chrome.storage.local.set({"login_status": {"status": "progress", "message": statusMessage}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        
                        // Continue monitoring for the next step or completion
                        let waitTime = 3000; // Default wait time
                        if (result.step === 'username_next') {
                            waitTime = 2000; // Shorter wait for next step
                        } else if (result.step === 'login_complete') {
                            waitTime = 4000; // Longer wait for final authentication
                        }
                        
                        setTimeout(() => {
                            waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth + 1);
                        }, waitTime);
                    } else {
                        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Could not complete login process"}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        chrome.tabs.remove(tabId);
                    }
                }).catch(error => {
                    // Don't fail immediately on connection errors - the tab might be navigating
                    if (error.message.includes("Could not establish connection") || 
                        error.message.includes("Receiving end does not exist") ||
                        error.message.includes("No tab with id")) {
                        // Continue monitoring instead of failing
                        setTimeout(() => {
                            waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth + 1);
                        }, 2000);
                    } else {
                        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login injection failed"}});
                        safeSendMessage({"method": "UpdateLoginStatus"});
                        chrome.tabs.remove(tabId);
                    }
                });
                return;
            }
            
            // Check if page seems fully loaded but no fields found - try different approach
            if (monitorCount > 15 && state.readyState === 'complete' && state.bodyHTMLLength > 1000 && 
                !state.hasUsernameField && !state.hasPasswordField && !state.hasSpinners) {
                
                // Try navigating directly to login endpoint if we're stuck on OAuth2 page
                if (state.url.includes('/oauth2/')) {
                    chrome.storage.local.get(["settings"], function(storage){
                        if (storage.settings && storage.settings.okta_domain) {
                            const directLoginUrl = "https://" + storage.settings.okta_domain + "/login/login.htm";
                            
                            chrome.tabs.update(tabId, { url: directLoginUrl }, function() {
                                chrome.storage.local.set({"login_status": {"status": "progress", "message": "Navigating to direct login page..."}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                
                                // Reset counter and continue monitoring on new page
                                setTimeout(() => {
                                    waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, 0);
                                }, 3000);
                            });
                            clearInterval(monitor_timer);
                            return;
                        }
                    });
                }
            }
            
            // Show progress message
            if (monitorCount % 10 === 0) {
                chrome.storage.local.set({"login_status": {"status": "progress", "message": `Waiting for login fields... (${Math.floor(monitorCount/10)*5}s)`}});
                safeSendMessage({"method": "UpdateLoginStatus"});
            }
            
        }).catch((error) => {
            // Log monitoring errors during tab navigation for debugging
            debugLog("Monitoring error during tab navigation:", error.message);
        });
        }, 500); // Check every 0.5 seconds for faster response
        
        // Timeout after 60 seconds (only on first recursion to avoid multiple timeouts)
        if (recursionDepth === 0) {
            setTimeout(() => {
                // Check if login already completed before setting failure status
                chrome.storage.local.get(["oauth2LoginCompleted"], function(result) {
                    if (result.oauth2LoginCompleted) {
                        // Login already completed successfully, don't overwrite status
                        debugLog("OAuth2 timeout fired but login already completed - ignoring");
                        return;
                    }
                    clearInterval(monitor_timer);
                    chrome.storage.local.set({"login_status": {"status": "failed", "message": "OAuth2 login fields never appeared"}});
                    safeSendMessage({"method": "UpdateLoginStatus"});
                    chrome.tabs.remove(tabId);
                });
            }, OAUTH2_TIMEOUT_MS);
        }
    }, 2000); // Wait 2 seconds after tab activation
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
