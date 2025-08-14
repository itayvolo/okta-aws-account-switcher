// AWS Account Switcher - Service Worker

function get_all_accounts() {
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
    chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
    aws_login(function(tab_id){
        chrome.scripting.executeScript({
            target: {tabId: tab_id},
            files: ['get_accounts.js']
        }).then((results) => {
            const accounts = results[0].result;
            if (!accounts) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Failed to get accounts"}})
                chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            chrome.storage.local.get(["accounts"], accounts_storage => {
                if (accounts_storage.accounts == undefined) {
                    accounts_storage.accounts = {}; 
                }
                chrome.storage.local.get(["settings"], settings_storage => {
                    if (settings_storage.settings == undefined) {settings_storage.settings = {}}
                    if (settings_storage.settings.role_filters == undefined) {settings_storage.settings.role_filters = []}
                    var role_filters = settings_storage.settings.role_filters;
                    accounts.forEach(account => {
                        var matches = account.name.match(/Account: (.+) \(([0-9]+)\)/);
                        var account_name = matches[1] + '/' + account.role;
                        var account_id = matches[2];
                        if (role_filters.length > 0 && role_filters.indexOf(account.role) == -1) {
                            if (accounts_storage.accounts[account_name] != undefined) {
                                delete accounts_storage.accounts[account_name];
                            }
                        } else {
                            if (accounts_storage.accounts[account_name] == undefined) {
                                accounts_storage.accounts[account_name] = {"id": account_id, "status": "expired"};
                            }
                        }
                    });
                    chrome.storage.local.set(accounts_storage);
                    chrome.tabs.remove(tab_id);
                    chrome.storage.local.set({accountsstatus: "ready"})
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Successfully retrieved the list of AWS accounts."}})
                    chrome.runtime.sendMessage({"method": "UpdatePopup"});
                });
            });
        }).catch((error) => {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
        });
    })
}

function change_account(account){
    save (false, function() {
        chrome.cookies.getAll({"domain": ".amazon.com"}, function(cookies_to_remove) {
            for (i = 0; i<cookies_to_remove.length; i++) {
                if (cookies_to_remove[i].name == "noflush_awscnm") {continue;}
                var cookie_to_remove = {};
                cookie_to_remove.name = cookies_to_remove[i].name;
                var domain = cookies_to_remove[i].domain.match(/^\.?(.+)$/)[1];
                cookie_to_remove.url = "https://" + domain + cookies_to_remove[i].path;
                cookie_to_remove.storeId = cookies_to_remove[i].storeId;
                chrome.cookies.remove(cookie_to_remove);
            }
            chrome.storage.local.get(["accounts"], function(result) {
                cookies_to_add = result["accounts"][account].cookies;
                for (i=0; i<cookies_to_add.length; i++) {
                    var cookie_to_add = cookies_to_add[i];
                    delete cookie_to_add.hostOnly;
                    delete cookie_to_add.session;
                    var domain = cookie_to_add.domain.match(/^\.?(.+)$/)[1];
                    cookie_to_add.url = "https://" + domain + cookie_to_add.path;
                    chrome.cookies.set(cookie_to_add);            
                }
                refresh_all_aws_tabs();
            });
        });
    });
}

function refresh_all_aws_tabs() {
    chrome.tabs.query({"url": "*://*.console.aws.amazon.com/*"}, tabs => {
        if (tabs.length>0) {
            for (i=0; i<tabs.length; i++) {
                chrome.tabs.reload(tabs[i].id);
            }
        } else {
            chrome.tabs.create({"url": "https://console.aws.amazon.com/"});
        }
        chrome.storage.local.set({"accounts_status": {"status": "success", "message": "🎉 Account changed successfully!"}})
        chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
        chrome.tabs.query({ active: true, currentWindow: true }, active_tabs => {
            if (active_tabs[0] != undefined) {
                if (!active_tabs[0].url.includes("console.aws.amazon.com")) {
                    chrome.tabs.update(tabs[0].id, {selected: true});
                }
            }
        });
    });
}

function save(login, callback){
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Saving account cookies."}});
    chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
    var account_name, account_id, account_role;
    chrome.cookies.getAll({"domain": ".amazon.com"}, function(all_cookies){
        if (all_cookies.length == 0) {callback();return}
        for (i=0; i<all_cookies.length; i++) {
            if (all_cookies[i].name == "XSRF-TOKEN") {
                all_cookies.splice(i,1);
                i--;
            }
            if (all_cookies[i].name == "noflush_awscnm") {
                all_cookies.splice(i,1);
                i--;
            }
            if (all_cookies[i].name == "aws-userInfo") {
                if (all_cookies[i].domain === "amazon.com") {continue;}
                var userInfo = JSON.parse(decodeURIComponent(all_cookies[i].value));
                account_name = userInfo.alias;
                account_id = userInfo.arn.match(/sts::([0-9]+):/)[1];
                account_role = userInfo.arn.split('/')[1];
            }
        }
        if (account_name == undefined || account_id == undefined || account_role == undefined) {callback();return}
        var expirationDate;
        chrome.storage.local.get(["accounts"], function(storage) {
            if (storage.accounts != undefined && storage.accounts[account_name + '/' + account_role] != undefined) {
                expirationDate = storage.accounts[account_name + '/' + account_role].expirationDate;
            }
            if (login) {
                expirationDate = (Date.now()/1000) + (9 * 60 * 60);
            }
            storage.accounts[account_name + '/' + account_role] = {"id": account_id, "cookies": all_cookies, "expirationDate": expirationDate, "status": "ready"};
            chrome.storage.local.set(storage, function(){
                chrome.runtime.sendMessage({"method": "UpdatePopup"});
                callback();
            });
        });
    });
}

function login(account, callback) {
    chrome.storage.local.get(["accounts"], function(storage){
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing AWS account login"}});
        chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
        if (storage.accounts == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        if (storage.accounts[account] == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + account}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        var account_id = storage.accounts[account].id;
        var account_role = account.split('/')[1];
        aws_login(function(tab_id){
            chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing AWS account login"}});
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            chrome.scripting.executeScript({
                target: {tabId: tab_id},
                func: (account_id, account_role) => {
                    document.querySelector(`input[type="radio"][value*="${account_id}"][value*="${account_role}"]`).checked = true;
                    document.getElementById('signin_button').click();
                },
                args: [account_id, account_role]
            }).then(() => {
                var console_timer = setInterval(wait_console, 1000);
                function wait_console() {
                    chrome.scripting.executeScript({
                        target: {tabId: tab_id},
                        func: () => window.location.href
                    }).then((results) => {
                        const tab_url = results[0].result;
                        if (tab_url == undefined) {return}
                        if (tab_url.includes("console.aws.amazon.com")) {
                            clearInterval(console_timer);
                            save(true, function(){
                                chrome.tabs.query({"url": "*://*.console.aws.amazon.com/*"}, function(tabs){
                                    if (tabs.length > 1) {chrome.tabs.remove(tab_id);}
                                });
                                callback();   
                            });
                        }
                    }).catch((error) => {
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
                        chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
                        clearInterval(console_timer);
                    });
                }
            }).catch((error) => {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
                chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            });
        });
    });
}

function checkExpire(){
    chrome.storage.local.get(["accounts"], (result) => {
        if (result.accounts == undefined) {return}
        var items = result.accounts;
        if (items.length == 0) {return}
        var allKeys = Object.keys(items);
        var currentDate = Math.floor(Date.now() / 1000);
        for (i=0; i<allKeys.length; i++) {
            var account = allKeys[i];
            var expirationDate = items[account].expirationDate;
            var status = items[account].status;
            if (status == "expired") {
                continue;
            }
            if (expirationDate < currentDate) {
                result["accounts"][account].status = "expired";
                chrome.storage.local.set(result);
            }
        }
    });
}

chrome.runtime.onMessage.addListener( function(request, sender, sendResponse) {
    if (request.method == "changeAccount") {
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
        chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
        chrome.storage.local.get(["accounts"], function(result){
            if (result.accounts == undefined) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
                chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            if (result.accounts[request.account] == undefined) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + request.account}})
                chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            if (result.accounts[request.account].status == "expired") {
                login(request.account, refresh_all_aws_tabs);
            } else {
                change_account(request.account);
            }
        });
    }
    else if (request.method == "loginOkta") {
        okta_login();
    }
    else if (request.method == "getAllAccounts") {
        get_all_accounts();
    }
    else if (request.method == "loadOktaApps") {
        loadOktaApps();
    }
});

function registerAlarms(alarmName) {
    chrome.alarms.getAll(function(alarms) {
        var hasAlarm = alarms.some(function(a) {
            return a.name == alarmName;
        });
        if (hasAlarm) {
            chrome.alarms.clear(alarmName, function(){
                chrome.alarms.create(alarmName, {delayInMinutes: 1.0, periodInMinutes: 3.0});
            });
        } else {
            chrome.alarms.create(alarmName, {delayInMinutes: 1.0, periodInMinutes: 3.0});
        }
    })
}

chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name == "checkExpire") {
        checkExpire();
    }
});

chrome.idle.onStateChanged.addListener(function(state) {
    if (state == "active") {
        registerAlarms("checkExpire");
    }
});

function aws_login(callback) {
    chrome.storage.local.get(["settings"], function(storage){
        if (storage.settings == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Settings not found."}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            return;
        } 
        if (storage.settings.aws_app == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "AWS app not set!"}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        if (storage.settings.okta_domain == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "OKTA domain not set!"}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            return;
        };
        var aws_saml_url = storage.settings.aws_app.url;
        //Check okta login
        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs";
        fetch(list_apps_url, {
            method: 'GET',
            credentials: 'include'
        }).then(response => {
            if (!response.ok) {
                chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing okta login"}})
                chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
                okta_login(aws_login, callback);
                return;
            }
            chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Opening AWS login page"}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
            chrome.tabs.create({"url": aws_saml_url, "selected": false}, function(tab) {
                var signin_timer = setInterval(wait_signin, 1000);
                function wait_signin(){           
                    chrome.scripting.executeScript({
                        target: {tabId: tab.id},
                        func: () => window.location.href
                    }).then((results) => {
                        const tab_url = results[0].result;
                        if (tab_url != "https://signin.aws.amazon.com/saml") {return}
                        clearInterval(signin_timer);
                        callback(tab.id);
                    }).catch((error) => {
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
                        chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
                    });
                }
            });
        }).catch((error) => {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
            chrome.runtime.sendMessage({"method": "UpdateAccountsStatus"});
        });
    });
}

function okta_login(callback, callback_argument = null) {
    chrome.storage.local.get(["settings"], function(storage){
        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Connecting to Okta..."}});
        chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
        if (storage.settings == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! No settings found"}});
            chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_domain == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA domain not set"}});
            chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_username == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA username not set"}});
            chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_password == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA password not set"}});
            chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        var domain = storage.settings.okta_domain;
        var username = storage.settings.okta_username;
        var password = storage.settings.okta_password;

        
        // Let's try the root domain first to see what we get
        const okta_login_url = "https://" + domain + "/";
        // Update status to show we're opening login page
        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Opening Okta login..."}});
        chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});

        // First try to find an existing Okta tab to avoid creating a new one
        chrome.tabs.query({url: "*://" + domain + "/*"}, function(existingTabs) {
            if (existingTabs.length > 0) {
                // Use existing tab and navigate to root
                chrome.tabs.update(existingTabs[0].id, {url: okta_login_url}, function(tab) {
                    handleLoginTab(tab.id, callback, callback_argument, username, password);
                });
            } else {
                chrome.tabs.create({
                    "url": okta_login_url, 
                    "selected": false,
                    "active": false,
                    "pinned": false
                }, function(tab) {
                    handleLoginTab(tab.id, callback, callback_argument, username, password);
                });
            }
        });
    });
}

function handleLoginTab(tabId, callback, callback_argument, username, password) {
    
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
                        chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                        
                        // Inject login credentials and submit
                        chrome.scripting.executeScript({
                            target: {tabId: tabId},
                            func: (username, password) => {
                                // Check if user is already logged in
                                if (window.location.href.includes('session_hint=AUTHENTICATED') ||
                                    window.location.href.includes('/app/UserHome') ||
                                    window.location.href.includes('/dashboard') ||
                                    document.body.innerHTML.includes('Dashboard') ||
                                    document.body.innerHTML.includes('Applications')) {
                                    
                                    return { 
                                        success: true, 
                                        message: 'Already logged into Okta',
                                        alreadyLoggedIn: true 
                                    };
                                }
                                
                                // Check if we're on a login page and try to submit
                                if (document.title.includes('Sign In') || 
                                    document.body.innerHTML.includes('sign') ||
                                    document.body.innerHTML.includes('login') ||
                                    document.body.innerHTML.includes('auth')) {
                                    
                                    // Try to find login elements
                                    let usernameField = document.getElementById('okta-signin-username') ||
                                                       document.querySelector('input[name="username"]') ||
                                                       document.querySelector('input[type="email"]') ||
                                                       document.querySelector('input[autocomplete="username"]') ||
                                                       document.querySelector('input[placeholder*="username"]') ||
                                                       document.querySelector('input[placeholder*="email"]');
                                    
                                    let passwordField = document.getElementById('okta-signin-password') ||
                                                       document.querySelector('input[name="password"]') ||
                                                       document.querySelector('input[type="password"]');
                                    
                                    let submitButton = document.getElementById('okta-signin-submit') ||
                                                      document.querySelector('input[type="submit"]') ||
                                                      document.querySelector('button[type="submit"]') ||
                                                      document.querySelector('.okta-form-submit-button') ||
                                                      document.querySelector('button.btn-primary');
                                    
                                    if (usernameField && passwordField && submitButton) {
                                        usernameField.value = username;
                                        passwordField.value = password;
                                        
                                        // Trigger events
                                        usernameField.dispatchEvent(new Event('input', {bubbles: true}));
                                        usernameField.dispatchEvent(new Event('change', {bubbles: true}));
                                        passwordField.dispatchEvent(new Event('input', {bubbles: true}));
                                        passwordField.dispatchEvent(new Event('change', {bubbles: true}));
                                        
                                        setTimeout(() => submitButton.click(), 100);
                                        return { success: true, message: 'Login form submitted successfully' };
                                    }
                                }
                                
                                return { 
                                    success: false, 
                                    message: 'Could not find or submit login form',
                                    pageTitle: document.title,
                                    url: window.location.href
                                };
                            },
                            args: [username, password]
                        }).then((results) => {
                            const result = results[0].result;
                            
                            if (result.success) {
                                if (result.alreadyLoggedIn) {
                                    // Add a brief "completing login" phase for better UX
                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Completing authentication..."}});
                                    chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Show success after a brief moment
                                    setTimeout(() => {
                                        chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                                        chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                                        
                                        // Auto-refresh Okta applications after successful login
                                        setTimeout(() => {
                                            loadOktaApps();
                                        }, 500);
                                    }, 800);
                                    
                                    // Close the tab after success message is shown
                                    setTimeout(() => {
                                        chrome.tabs.remove(tabId);
                                        if (callback) {
                                            callback(callback_argument);
                                        }
                                    }, 2000); // Increased delay to show success message
                                } else {
                                    // Login form was submitted
                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Logging in to Okta..."}});
                                    chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Monitor for login completion or MFA
                                    monitorOktaLogin(tabId, callback, callback_argument);
                                }
                            } else {
                                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login form not found: " + result.message}});
                                chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                                chrome.tabs.remove(tabId);
                            }
                        }).catch(error => {
                            // Login injection failed
                            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login injection failed: " + error.message}});
                            chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                            chrome.tabs.remove(tabId);
                        });
                    }
                }).catch(error => {
                    // Tab readiness check failed
                    clearInterval(login_timer);
                    chrome.storage.local.set({"login_status": {"status": "failed", "message": "Tab loading failed: " + error.message}});
                    chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                    chrome.tabs.remove(tabId);
                });
            }, 1000);
}

function monitorOktaLogin(tabId, callback, callback_argument) {
    
    const monitor_timer = setInterval(function() {
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: () => {
                // Check current URL and page state
                const url = window.location.href;
                const title = document.title;
                
                // Check for MFA challenge
                const mfaElement = document.querySelector('[data-se="factor-push"]') || 
                                 document.querySelector('.okta-verify-challenge') ||
                                 document.querySelector('[data-se="mfa-verify-passcode"]');
                
                // Check for successful login (redirected to dashboard/apps)
                const isLoggedIn = url.includes('/app/') || 
                                  url.includes('/dashboard') || 
                                  url.includes('/user/profile') ||
                                  title.includes('Dashboard') ||
                                  document.querySelector('.okta-dashboard');
                
                // Check for login error
                const errorElement = document.querySelector('.okta-form-infobox-error') ||
                                   document.querySelector('[data-se="errors-container"]') ||
                                   document.querySelector('.error-16');
                
                return {
                    url: url,
                    title: title,
                    hasMFA: !!mfaElement,
                    isLoggedIn: isLoggedIn,
                    hasError: !!errorElement,
                    errorText: errorElement ? errorElement.textContent : null
                };
            }
        }).then((results) => {
            const state = results[0].result;
            
            if (state.hasError) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed: " + state.errorText}});
                chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                chrome.tabs.remove(tabId);
            } else if (state.hasMFA) {
                chrome.storage.local.set({"login_status": {"status": "progress", "message": "MFA challenge detected. Please complete authentication."}});
                chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                // Continue monitoring for MFA completion
            } else if (state.isLoggedIn) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
                
                // Auto-refresh Okta applications after successful login
                setTimeout(() => {
                    loadOktaApps();
                }, 500);
                
                // Close the login tab
                chrome.tabs.remove(tabId);
                
                // Call the callback if provided
                if (callback) {
                    callback(callback_argument);
                }
            }
        }).catch(error => {
            // Monitor error occurred
            clearInterval(monitor_timer);
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Monitoring failed: " + error.message}});
            chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
            chrome.tabs.remove(tabId);
        });
    }, 2000);
    
    // Timeout after 60 seconds
    setTimeout(() => {
        clearInterval(monitor_timer);
        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login timeout - please try again"}});
        try {
    chrome.runtime.sendMessage({"method": "UpdateLoginStatus"});
} catch (error) {
    // Popup closed, continuing in background
}
        chrome.tabs.remove(tabId);
    }, 60000);
}


function loadOktaApps() {
    chrome.storage.local.get(["settings"], function(storage){
        if (storage.settings == undefined || storage.settings.okta_domain == undefined) {
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "OKTA domain not set"}});
            chrome.runtime.sendMessage({"method": "UpdateOktaApps"});
            return;
        }
        
        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
        fetch(list_apps_url, {
            method: 'GET',
            credentials: 'include'
        }).then(response => {
            if (!response.ok) {
                let message = response.status === 403 ? "Failed to get the list of okta applications. Need to login!" : "Failed to get the list of okta applications. Status: " + response.status;
                chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": message}});
                chrome.runtime.sendMessage({"method": "UpdateOktaApps"});
                return;
            }
            return response.json();
        }).then(okta_tabs => {
            if (!okta_tabs) return;
            
            chrome.storage.local.set({"okta_apps_status": {"status": "success", "apps": okta_tabs}});
            chrome.runtime.sendMessage({"method": "UpdateOktaApps"});
        }).catch(error => {
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "Request failed: " + error.message}});
            chrome.runtime.sendMessage({"method": "UpdateOktaApps"});
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
