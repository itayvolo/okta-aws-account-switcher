// Okta login and AWS app detection.

// Auto-detect AWS app from Okta apps list
// Pull the AWS apps out of an Okta "home/tabs" API response, normalized to
// { label, url }. Handles both the flat `apps` shape and the expanded
// `items[].resource` shape.
function extractAwsApps(okta_data) {
    if (!okta_data) return [];

    // Collect app objects regardless of how Okta shaped the response: apps can
    // sit under tab.apps, tab.items[].resource, or the ?expand= embedded form
    // (tab._embedded.items[]._embedded.resource). Walk the tree and grab any
    // node that looks like an app tile.
    const allApps = [];
    const walk = node => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== "object") return;

        const items = node.items || (node._embedded && node._embedded.items);
        const apps = node.apps;
        if (Array.isArray(items) || Array.isArray(apps)) {
            if (Array.isArray(apps)) apps.forEach(a => allApps.push(a));
            if (Array.isArray(items)) {
                items.forEach(it => allApps.push(it.resource || (it._embedded && it._embedded.resource) || it));
            }
            return;
        }
        if (node.linkUrl || node.href || node.loginUrl || node.appName || node.label) {
            allApps.push(node);
        }
    };
    walk(okta_data);

    const urlOf = app => app.linkUrl || app.href || app.loginUrl || "";
    const isAws = app => {
        const hay = [app.label, app.name, app.appName, urlOf(app)].filter(Boolean).join(" ").toLowerCase();
        return hay.includes("amazon") || hay.includes("aws");
    };

    const seen = new Set();
    const out = [];
    allApps.forEach(app => {
        if (!isAws(app)) return;
        const url = urlOf(app);
        if (!url || seen.has(url)) return;
        seen.add(url);
        out.push({ label: app.label || app.name || app.appName || "AWS", url: url });
    });
    return out;
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
        pruneBlankApps(result.settings);

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
