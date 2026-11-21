// Account list refresh, bulk login/logout and expiry.

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
                    // Drop accounts/roles the portal no longer lists.
                    if (parsed.length > 0) {
                        const listed = new Set(parsed.map(a => a.account_name));
                        Object.keys(appAccounts).forEach(k => { if (!listed.has(k)) delete appAccounts[k]; });
                    }
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

function login_all_accounts(appId) {
    getActiveApp(function(app, preset) {
        chrome.storage.local.get(["accounts", "last_roles"], function(result) {
            const appAccounts = (result.accounts && result.accounts[app.id]) || {};
            const lastRoles = (result.last_roles && result.last_roles[app.id]) || {};
            // One login per account (its preferred role), skipping accounts with any role ready.
            const byName = {};
            Object.keys(appAccounts).forEach(k => {
                const i = k.indexOf('/');
                const name = k.slice(0, i);
                (byName[name] = byName[name] || []).push({role: k.slice(i + 1), status: appAccounts[k].status});
            });
            const expiredKeys = Object.keys(byName)
                .filter(n => !byName[n].some(r => r.status === "ready"))
                .map(n => n + '/' + pickAccountRole(byName[n], lastRoles[n]));
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
                    reloadConsoleTabs(preset);
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Logged out of " + count + " account" + (count === 1 ? "" : "s") + "."}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    safeSendMessage({"method": "UpdatePopup"});
                });
            });
        });
    }, "accounts_status", appId);
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
