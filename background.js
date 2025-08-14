// AWS Account Switcher - Service Worker

function safeSendMessage(message) {
    try {
        chrome.runtime.sendMessage(message);
    } catch (e) {
        // Popup is not open, continuing in background
        console.log("Popup not open:", e.message);
    }
}

function get_all_accounts() {
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
    safeSendMessage({"method": "UpdateAccountsStatus"});
    aws_login(function(tab_id){
        chrome.scripting.executeScript({
            target: {tabId: tab_id},
            files: ['get_accounts.js']
        }).then((results) => {
            const accounts = results[0].result;
            if (!accounts) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Failed to get accounts"}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
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
                    safeSendMessage({"method": "UpdatePopup"});
                });
            });
        }).catch((error) => {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
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

function save(login, callback){
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Saving account cookies."}});
    safeSendMessage({"method": "UpdateAccountsStatus"});
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
                safeSendMessage({"method": "UpdatePopup"});
                callback();
            });
        });
    });
}

function login(account, callback) {
    chrome.storage.local.get(["accounts"], function(storage){
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing AWS account login"}});
        safeSendMessage({"method": "UpdateAccountsStatus"});
        if (storage.accounts == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        if (storage.accounts[account] == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + account}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        var account_id = storage.accounts[account].id;
        var account_role = account.split('/')[1];
        aws_login(function(tab_id){
            chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing AWS account login"}});
            safeSendMessage({"method": "UpdateAccountsStatus"});
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
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        clearInterval(console_timer);
                    });
                }
            }).catch((error) => {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
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
        safeSendMessage({"method": "UpdateAccountsStatus"});
        chrome.storage.local.get(["accounts"], function(result){
            if (result.accounts == undefined) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            if (result.accounts[request.account] == undefined) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + request.account}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
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
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        } 
        if (storage.settings.aws_app == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "AWS app not set!"}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        if (storage.settings.okta_domain == undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "OKTA domain not set!"}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
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
                safeSendMessage({"method": "UpdateAccountsStatus"});
                okta_login(aws_login, callback);
                return;
            }
            chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Opening AWS login page"}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
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
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                    });
                }
            });
        }).catch((error) => {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
        });
    });
}

function okta_login(callback, callback_argument = null) {
    // Store current active tab to return to later
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const originalTab = tabs[0];
        chrome.storage.local.set({"originalTab": {id: originalTab.id, url: originalTab.url}});
        
        chrome.storage.local.get(["settings"], function(storage){
            chrome.storage.local.set({"login_status": {"status": "progress", "message": "Starting seamless login..."}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            
            // Set badge to show login in progress
            chrome.action.setBadgeText({text: "..."});
            chrome.action.setBadgeBackgroundColor({color: "#2196F3"});
            
            if (storage.settings == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! No settings found"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_domain == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA domain not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_username == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA username not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        if (storage.settings.okta_password == undefined) {
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA password not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }
        var domain = storage.settings.okta_domain;
        var username = storage.settings.okta_username;
        var password = storage.settings.okta_password;
        
        // Go to root domain and wait for OAuth2 flow to present login fields
        const okta_url = "https://" + domain + "/";
        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Starting OAuth2 flow..."}});
        safeSendMessage({"method": "UpdateLoginStatus"});

        // First try to find an existing Okta tab
        chrome.tabs.query({url: "*://" + domain + "/*"}, function(existingTabs) {
            if (existingTabs.length > 0) {
                // Use existing tab but make it background
                chrome.tabs.update(existingTabs[0].id, {url: okta_url, active: false}, function(tab) {
                    waitForOAuth2LoginFields(tab.id, callback, callback_argument, username, password);
                });
            } else {
                chrome.tabs.create({
                    "url": okta_url, 
                    "active": false  // Keep in background initially to preserve popup
                }, function(tab) {
                    waitForOAuth2LoginFields(tab.id, callback, callback_argument, username, password);
                });
            }
        });
        });
    });
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
                                console.log("SCRIPT INJECTION STARTED - VERY FIRST LINE");
                                try {
                                    console.log("INSIDE TRY BLOCK");
                                    // ALWAYS run comprehensive page analysis FIRST - before any other code
                                    console.log("=== COMPREHENSIVE PAGE ANALYSIS STARTING ===");
                                    console.log("Login injection script starting");
                                    console.log("Page URL:", window.location.href);
                                    console.log("Page title:", document.title);
                                    console.log("Document ready state:", document.readyState);
                                    console.log("Body text preview:", document.body ? document.body.textContent.substring(0, 200) : 'NO BODY');
                                    
                                    
                                    // Don't assume login status from page content - always verify with actual login attempt
                                    // The API call validation will happen separately
                                    
                                    // SKIP the "already logged in" check - force complete login flow
                                    // This ensures we establish a proper Okta session that can access APIs
                                    console.log("Forcing complete login flow to ensure proper session establishment");
                                    
                                    // Don't check for existing login - always proceed with credential injection
                                    // This will ensure we get a fresh, valid session
                                
                                // Check what's actually on this page to understand what we're dealing with
                                console.log("=== DETAILED PAGE ANALYSIS ===");
                                console.log("Page URL:", window.location.href);
                                console.log("Page title:", document.title);
                                
                                // Log all elements on the page to see what we're missing
                                const allInputs = Array.from(document.querySelectorAll('input'));
                                const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
                                const allClickable = Array.from(document.querySelectorAll('*[onclick], button, input, a, [role="button"], [tabindex]'));
                                
                                console.log("ALL INPUTS (" + allInputs.length + "):");
                                allInputs.forEach((inp, i) => {
                                    console.log(`  ${i+1}. ${inp.tagName} - type:"${inp.type}" name:"${inp.name}" id:"${inp.id}" value:"${inp.value}" class:"${inp.className}"`);
                                });
                                
                                console.log("ALL BUTTONS (" + allButtons.length + "):");
                                allButtons.forEach((btn, i) => {
                                    console.log(`  ${i+1}. ${btn.tagName} - type:"${btn.type}" id:"${btn.id}" class:"${btn.className}" text:"${(btn.textContent || btn.value || '').substring(0,50)}"`);
                                });
                                
                                console.log("ALL CLICKABLE (" + allClickable.length + "):");
                                allClickable.forEach((el, i) => {
                                    if (i < 10) { // Limit to first 10
                                        console.log(`  ${i+1}. ${el.tagName} - id:"${el.id}" class:"${el.className}" text:"${(el.textContent || '').substring(0,50)}" href:"${el.href || ''}" onclick:"${el.onclick || ''}"`);
                                    }
                                });
                                
                                // If this is an OAuth2 page, maybe we need to click something to get to the login page
                                if (window.location.href.includes('/oauth2') || window.location.href.includes('/authorize')) {
                                    console.log("This is an OAuth2 page - looking for elements that might take us to login");
                                    
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
                                    
                                    console.log("POTENTIAL LOGIN TRIGGERS (" + potentialLoginTriggers.length + "):");
                                    potentialLoginTriggers.forEach((el, i) => {
                                        console.log(`  ${i+1}. ${el.tagName} - "${(el.textContent || '').substring(0,30)}" class:"${el.className}" id:"${el.id}"`);
                                    });
                                    
                                    // If we found something that looks like a login trigger, click it
                                    if (potentialLoginTriggers.length > 0) {
                                        console.log("Clicking potential login trigger:", potentialLoginTriggers[0].tagName, potentialLoginTriggers[0].textContent || potentialLoginTriggers[0].id);
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
                                        console.log("No obvious login triggers, trying first button:", allButtons[0].textContent || allButtons[0].value);
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
                                        console.log("ALL LINKS FOUND:");
                                        links.forEach((link, i) => {
                                            console.log(`  ${i+1}. "${(link.textContent || '').substring(0,30)}" -> ${link.href}`);
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
                                        
                                        console.log("SAME-DOMAIN LOGIN LINKS (" + loginLinks.length + "):");
                                        loginLinks.forEach((link, i) => {
                                            console.log(`  ${i+1}. "${(link.textContent || '').substring(0,30)}" -> ${link.href}`);
                                        });
                                        
                                        if (loginLinks.length > 0) {
                                            console.log("Clicking same-domain login link:", loginLinks[0].textContent, loginLinks[0].href);
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
                                        console.log("No same-domain login links found, trying direct navigation to /login");
                                        const loginUrl = window.location.protocol + '//' + window.location.hostname + '/login/login.htm';
                                        console.log("Navigating directly to:", loginUrl);
                                        window.location.href = loginUrl;
                                        
                                        return {
                                            success: false,
                                            message: 'No login links found - navigating directly to /login',
                                            pageTitle: document.title,
                                            url: window.location.href,
                                            navigatedTo: loginUrl
                                        };
                                    }
                                    
                                    console.log("No interactive elements found on OAuth2 page that look like login triggers");
                                }
                                
                                // Try to find login elements with comprehensive selectors
                                let usernameField = null;
                                let passwordField = null;
                                let submitButton = null;
                                
                                // Always attempt login form detection and submission
                                console.log("Attempting to find and submit login form...");
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
                                    console.log("Login form search results:");
                                    console.log("Username field found:", !!usernameField, usernameField?.tagName, usernameField?.id, usernameField?.name);
                                    console.log("Password field found:", !!passwordField, passwordField?.tagName, passwordField?.id, passwordField?.name);
                                    console.log("Submit button found:", !!submitButton, submitButton?.tagName, submitButton?.id, submitButton?.className);
                                    
                                    if (usernameField && passwordField && submitButton) {
                                        console.log("Filling login form and submitting");
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
                                        console.log("Primary selectors failed, trying enhanced fallback...");
                                        
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
                                            console.log("Fallback username field:", usernameField ? {tag: usernameField.tagName, type: usernameField.type, name: usernameField.name, id: usernameField.id} : 'none');
                                        }
                                        
                                        // Try any password input if not found
                                        if (!passwordField) {
                                            passwordField = allInputs.find(inp => inp.type === 'password');
                                            console.log("Fallback password field:", passwordField ? {tag: passwordField.tagName, type: passwordField.type, name: passwordField.name, id: passwordField.id} : 'none');
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
                                            console.log("Fallback submit button:", submitButton ? {tag: submitButton.tagName, type: submitButton.type, text: submitButton.textContent?.substring(0,30)} : 'none');
                                        }
                                        
                                        if (usernameField && passwordField && submitButton) {
                                            console.log("Using fallback fields for login");
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
                                    console.log("Page doesn't look like a typical login page, but trying to find login fields anyway...");
                                }
                                
                                // Always try to find login fields as a last resort, regardless of page detection
                                console.log("Final attempt: searching for any login fields on page...");
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
                                        console.log("Found login fields in final attempt - submitting");
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
                                        totalForms: allForms.length,
                                        bodyPreview: document.body ? document.body.textContent.substring(0, 200) : 'NO BODY',
                                        isOAuth2Page: window.location.href.includes('/oauth2') || window.location.href.includes('/authorize'),
                                        hasPasswordInput: document.querySelectorAll('input[type="password"]').length > 0,
                                        hasUsernameInput: document.querySelectorAll('input[name="username"], input[type="email"], input[type="text"]').length > 0,
                                        clickableElements: Array.from(document.querySelectorAll('*[onclick], button, input, a, [role="button"]')).length
                                    }
                                };
                                } catch (error) {
                                    console.log("CAUGHT ERROR IN SCRIPT:", error);
                                    console.log("Error message:", error.message);
                                    console.log("Error stack:", error.stack);
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
                            console.log("Login injection raw results:", results);
                            
                            if (!results || results.length === 0) {
                                chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login script returned no results"}});
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                chrome.tabs.remove(tabId);
                                return;
                            }
                            
                            const result = results[0]?.result;
                            console.log("Login injection result:", result);
                            
                            // Log detailed analysis if available
                            if (result?.analysis) {
                                console.log("=== PAGE ANALYSIS SUMMARY ===");
                                console.log("Page title:", result.pageTitle || 'EMPTY');
                                console.log("URL:", result.url || 'UNKNOWN');
                                console.log("Is OAuth2 page:", result.analysis.isOAuth2Page);
                                console.log("Total inputs:", result.analysis.totalInputs);
                                console.log("Total buttons:", result.analysis.totalButtons);
                                console.log("Total forms:", result.analysis.totalForms);
                                console.log("Has password input:", result.analysis.hasPasswordInput);
                                console.log("Has username input:", result.analysis.hasUsernameInput);
                                console.log("Clickable elements:", result.analysis.clickableElements);
                                console.log("Body preview:", result.analysis.bodyPreview);
                                console.log("=== END ANALYSIS ===");
                                
                                // Check if we're already on an authenticated dashboard page
                                if (result.url && (result.url.includes('/app/UserHome') || result.url.includes('session_hint=AUTHENTICATED'))) {
                                    console.log("🎉 Already authenticated and on dashboard! Skipping login and loading applications directly.");
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
                                                    console.log("Service worker API failed, falling back to tab-based approach");
                                                    // Fall back to tab-based approach as last resort
                                                    setTimeout(() => {
                                                        makeOktaApiCall(tabId, list_apps_url, true);
                                                    }, 2000);
                                                }
                                            }).catch(error => {
                                                console.log("Service worker API error:", error.message, "- falling back to tab approach");
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
                                console.log("Detected OAuth2 page - monitoring for login fields to inject credentials");
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
                                                    console.log("Testing API access to:", apiUrl);
                                                    console.log("Current page URL:", window.location.href);
                                                    return fetch(apiUrl, {
                                                        method: 'GET',
                                                        credentials: 'include'
                                                    }).then(response => {
                                                        console.log("API test response status:", response.status);
                                                        return {
                                                            success: response.ok,
                                                            status: response.status,
                                                            url: window.location.href,
                                                            title: document.title
                                                        };
                                                    }).catch(error => {
                                                        console.log("API test error:", error.message);
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
                                                    chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                                    
                                                    // Navigate to dashboard to get proper session before loading apps
                                                    const dashboardUrl = "https://" + storage.settings.okta_domain + "/app/UserHome";
                                                    console.log("Navigating to dashboard for proper session:", dashboardUrl);
                                                    
                                                    chrome.tabs.update(tabId, {url: dashboardUrl}, function() {
                                                        console.log("Tab navigation initiated, waiting for dashboard to load...");
                                                        // Use navigation verification instead of fixed timeout
                                                        waitForTabNavigation(tabId, dashboardUrl, function(success) {
                                                            if (success) {
                                                                console.log("Dashboard navigation confirmed, establishing session...");
                                                                // Refresh the dashboard page to ensure session is fully established
                                                                chrome.tabs.reload(tabId, function() {
                                                                    console.log("Dashboard page refreshed, waiting for session establishment...");
                                                                    // Wait longer for session to be fully established
                                                                    setTimeout(() => {
                                                                        console.log("Session establishment complete, auto-loading applications (API verification path)");
                                                                        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                                                                        makeOktaApiCall(tabId, list_apps_url, true); // closeTab = true after apps loaded
                                                                    }, 5000); // Increased wait time to 5 seconds
                                                                });
                                                            } else {
                                                                console.log("Dashboard navigation failed, closing tab");
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
                                                        setTimeout(() => {
                                                            handleLoginTab(tabId, callback, callback_argument, storage.settings.okta_username, storage.settings.okta_password, true);
                                                        }, 2000);
                                                    });
                                                }
                                            }).catch(error => {
                                                // API test script injection failed - try normal login
                                                chrome.storage.local.set({"login_status": {"status": "progress", "message": "API test failed, retrying login..."}});
                                                try {
                                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                                } catch (e) {
                                                    console.log("Popup not open, continuing in background");
                                                }
                                                
                                                // Continue with normal login flow
                                                chrome.tabs.update(tabId, {url: "https://" + storage.settings.okta_domain + "/"}, function() {
                                                    setTimeout(() => {
                                                        handleLoginTab(tabId, callback, callback_argument, storage.settings.okta_username, storage.settings.okta_password, true);
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
                                    chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Navigate to dashboard to get proper session before loading apps
                                    chrome.storage.local.get(["settings"], function(storage){
                                        if (storage.settings && storage.settings.okta_domain) {
                                            const dashboardUrl = "https://" + storage.settings.okta_domain + "/app/UserHome";
                                            console.log("Navigating to dashboard for proper session:", dashboardUrl);
                                            
                                            chrome.tabs.update(tabId, {url: dashboardUrl}, function() {
                                                console.log("Tab navigation initiated, waiting for dashboard to load...");
                                                // Use navigation verification instead of fixed timeout
                                                waitForTabNavigation(tabId, dashboardUrl, function(success) {
                                                    if (success) {
                                                        console.log("Dashboard navigation confirmed, establishing session...");
                                                        // Refresh the dashboard page to ensure session is fully established
                                                        chrome.tabs.reload(tabId, function() {
                                                            console.log("Dashboard page refreshed, waiting for session establishment...");
                                                            // Wait longer for session to be fully established
                                                            setTimeout(() => {
                                                                console.log("Session establishment complete, auto-loading applications (skipApiCheck path)");
                                                                const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                                                                makeOktaApiCall(tabId, list_apps_url, true); // closeTab = true after apps loaded
                                                            }, 5000); // Increased wait time to 5 seconds
                                                        });
                                                    } else {
                                                        console.log("Dashboard navigation failed, closing tab");
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
                                    console.log("Navigated to new page, starting monitoring:", result.navigatedTo);
                                    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Navigated to login page, looking for login fields..."}});
                                    safeSendMessage({"method": "UpdateLoginStatus"});
                                    
                                    // Wait for navigation to complete then start monitoring
                                    setTimeout(() => {
                                        console.log("Starting monitoring after navigation");
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

function waitForTabNavigation(tabId, expectedUrl, callback) {
    let attempts = 0;
    const maxAttempts = 15; // 15 seconds total wait time
    
    const checkNavigation = setInterval(function() {
        attempts++;
        
        chrome.tabs.get(tabId, function(tab) {
            if (chrome.runtime.lastError) {
                console.log("Tab no longer exists during navigation wait");
                clearInterval(checkNavigation);
                callback(false);
                return;
            }
            
            console.log(`Navigation check ${attempts}/${maxAttempts}: Current URL: ${tab.url}`);
            
            // Check if we've successfully navigated to the expected URL or a related dashboard URL
            if (tab.url.includes('/app/UserHome') || tab.url.includes('/dashboard') || tab.url.includes('/user/profile')) {
                console.log("Successfully navigated to dashboard-like page");
                clearInterval(checkNavigation);
                callback(true);
                return;
            }
            
            // If we've waited long enough, give up
            if (attempts >= maxAttempts) {
                console.log("Navigation timeout - giving up");
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
            console.log(`Monitoring state (attempt ${monitorCount}):`, state);
            
            // Add debugging every few attempts to see what's on the page
            if (monitorCount % 5 === 1) {
                console.log(`=== DEBUG: What's on the page (attempt ${monitorCount}) ===`);
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
                    console.log(`Page URL: ${debug.url}`);
                    console.log(`Page Title: ${debug.title}`);
                    console.log(`Body Preview: ${debug.bodyPreview}`);
                    console.log(`Inputs (${debug.inputs.length}):`, debug.inputs);
                    console.log(`Buttons (${debug.buttons.length}):`, debug.buttons);
                    console.log(`Forms (${debug.forms.length}):`, debug.forms);
                    console.log(`All login-related elements (${debug.allElements.length}):`, debug.allElements);
                }).catch(err => console.log("Debug failed:", err.message));
            }
            
            // If we find login fields, inject credentials immediately
            if (state.hasUsernameField && state.hasPasswordField) {
                console.log("Login fields found - injecting credentials immediately");
                clearInterval(monitor_timer);
                
                chrome.storage.local.set({"login_status": {"status": "progress", "message": "Auto-filling login credentials..."}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                
                chrome.storage.local.get(["settings"], function(storage){
                    if (storage.settings && storage.settings.okta_username && storage.settings.okta_password) {
                        chrome.scripting.executeScript({
                            target: {tabId: tabId},
                            func: (username, password) => {
                                console.log("Injecting credentials on page:", window.location.href);
                                
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
                                    console.log("Filling and submitting login form");
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
                            args: [storage.settings.okta_username, storage.settings.okta_password]
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
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful!"}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                
                // Add badge to extension icon to indicate successful login
                chrome.action.setBadgeText({text: "✓"});
                chrome.action.setBadgeBackgroundColor({color: "#4CAF50"});
                
                // Show success notification
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'Icons/icon_48.png',
                    title: 'AWS Account Switcher',
                    message: 'Login successful! Applications loading...'
                });
                
                // Original tab return is handled by credential injection logic
                
                // Load apps directly from current dashboard page
                chrome.storage.local.get(["settings"], function(storage){
                    if (storage.settings && storage.settings.okta_domain) {
                        // Update badge to show apps loading
                        chrome.action.setBadgeText({text: "📱"});
                        chrome.action.setBadgeBackgroundColor({color: "#9C27B0"});
                        
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
            console.log(`Manual login monitoring (attempt ${monitorCount}):`, state);
            
            if (state.isLoggedIn) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful! Loading applications..."}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                
                // Auto-load applications
                chrome.storage.local.get(["settings"], function(storage){
                    if (storage.settings && storage.settings.okta_domain) {
                        console.log("Manual login successful - auto-loading applications");
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
            console.log("Manual login monitoring error:", error.message);
        });
    }, 3000); // Check every 3 seconds
    
    // Timeout after 5 minutes
    setTimeout(() => {
        clearInterval(monitor_timer);
        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Manual login timed out after 5 minutes"}});
        safeSendMessage({"method": "UpdateLoginStatus"});
    }, 300000);
}

function waitForOAuth2LoginFields(tabId, callback, callback_argument, username, password, recursionDepth = 0) {
    // Prevent infinite recursion
    if (recursionDepth >= 5) {
        console.log("Maximum recursion depth reached for OAuth2 monitoring - finishing");
        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login process took too long"}});
        safeSendMessage({"method": "UpdateLoginStatus"});
        chrome.tabs.remove(tabId);
        return;
    }
    
    // Make tab active briefly so login form loads properly
    chrome.tabs.update(tabId, { active: true }, function() {
        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Loading login form..."}});
        safeSendMessage({"method": "UpdateLoginStatus"});
        
        // Tab will return to original after login fields are found and injected
    });
    
    let monitorCount = 0;
    let hasReturnedToOriginalTab = false; // Flag to prevent multiple tab switches
    
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
                if (!hasReturnedToOriginalTab) {
                    hasReturnedToOriginalTab = true;
                    chrome.storage.local.get(["originalTab"], function(result) {
                        if (result.originalTab && result.originalTab.id) {
                            chrome.tabs.update(result.originalTab.id, { active: true }).catch(() => {
                                // Original tab may have been closed, that's OK
                            });
                        }
                    });
                }
                
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
            
        }).catch(() => {
            // Silently handle monitoring errors during tab navigation
        });
        }, 500); // Check every 0.5 seconds for faster response
        
        // Timeout after 60 seconds
        setTimeout(() => {
            clearInterval(monitor_timer);
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "OAuth2 login fields never appeared"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            chrome.tabs.remove(tabId);
        }, 60000);
    }, 2000); // Wait 2 seconds after tab activation
}


function loadOktaApps() {
    chrome.storage.local.get(["settings"], function(storage){
        if (storage.settings == undefined || storage.settings.okta_domain == undefined) {
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "OKTA domain not set"}});
            safeSendMessage({"method": "UpdateOktaApps"});
            return;
        }
        
        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
        const okta_domain = storage.settings.okta_domain;
        
        // First try the direct service worker fetch with proper host permissions
        console.log("Manual app refresh requested - attempting direct API call to:", list_apps_url);
        fetch(list_apps_url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        }).then(response => {
            console.log("Direct API response status:", response.status);
            if (response.ok) {
                return response.json().then(okta_tabs => {
                    console.log("Direct API call succeeded");
                    chrome.storage.local.set({"okta_apps_status": {"status": "success", "apps": okta_tabs}});
                    safeSendMessage({"method": "UpdateOktaApps"});
                });
            } else {
                console.log("Direct API call failed (status:", response.status, "), trying tab-based approach");
                // Always fallback to tab-based approach - service worker doesn't have access to browser session cookies
                loadOktaAppsViaTab(okta_domain, list_apps_url);
            }
        }).catch(error => {
            console.log("Direct API call error:", error.message, "- falling back to tab approach");
            // Fallback to tab-based approach
            loadOktaAppsViaTab(okta_domain, list_apps_url);
        });
    });
}

function loadOktaAppsViaTab(okta_domain, list_apps_url) {
    // Look for any existing Okta tabs that might have a valid session
    console.log("Searching for Okta tabs with pattern: *://" + okta_domain + "/*");
    chrome.tabs.query({url: "*://" + okta_domain + "/*"}, function(existingTabs) {
        console.log("Tab query result:", existingTabs.map(tab => ({id: tab.id, url: tab.url, title: tab.title})));
        
        if (existingTabs.length > 0) {
            console.log(`Found ${existingTabs.length} existing Okta tab(s), trying the first one`);
            // Filter for tabs that look like they might be logged in (not on login/auth pages)
            const loggedInTabs = existingTabs.filter(tab => 
                !tab.url.includes('/login') && 
                !tab.url.includes('/signin') && 
                !tab.url.includes('/oauth2') &&
                !tab.url.includes('/authorize')
            );
            
            if (loggedInTabs.length > 0) {
                console.log("Found potentially logged-in tab:", loggedInTabs[0].url);
                makeOktaApiCall(loggedInTabs[0].id, list_apps_url);
            } else {
                console.log("All tabs appear to be on login pages, using first tab anyway:", existingTabs[0].url);
                makeOktaApiCall(existingTabs[0].id, list_apps_url);
            }
        } else {
            console.log("No existing Okta tabs found, user needs to login first");
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "No Okta session found. Please login first!"}});
            safeSendMessage({"method": "UpdateOktaApps"});
        }
    });
}

function makeOktaApiCall(tabId, apiUrl, closeTab = false, callback = null, retryCount = 0) {
    // First verify the tab still exists
    chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError) {
            console.log("Tab no longer exists:", chrome.runtime.lastError.message);
            // Always set error status - this helps user understand what happened
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "Okta tab was closed before API call"}});
            safeSendMessage({"method": "UpdateOktaApps"});
            if (callback) callback(false);
            return;
        }
        
        console.log("Making API call on existing tab:", tab.url);
        console.log("Expected tab to be on dashboard, but URL is:", tab.url);
        
        // Check if tab reverted to OAuth2 page
        if (tab.url.includes('/oauth2') || tab.url.includes('/authorize')) {
            console.log("ERROR: Tab reverted to OAuth2 page after dashboard navigation!");
            
            if (retryCount >= 2) {
                console.log("Too many retries, giving up on navigation fix");
                chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "Tab keeps reverting to OAuth2 page - session may not be established"}});
                safeSendMessage({"method": "UpdateOktaApps"});
                if (callback) callback(false);
                chrome.tabs.remove(tabId);
                return;
            }
            
            console.log(`Attempting to navigate back to dashboard (retry ${retryCount + 1}/2)...`);
            
            // Extract domain from current URL
            const domain = new URL(tab.url).hostname;
            const dashboardUrl = "https://" + domain + "/app/UserHome";
            
            chrome.tabs.update(tabId, {url: dashboardUrl}, function() {
                console.log("Re-navigated to dashboard, waiting before API call...");
                setTimeout(() => {
                    // Recursive call after navigation with incremented retry count
                    makeOktaApiCall(tabId, apiUrl, closeTab, callback, retryCount + 1);
                }, 3000);
            });
            return;
        }
        
        console.log("Tab URL looks correct for API call:", tab.url);
        
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: (url) => {
                console.log("=== API CALL SCRIPT STARTING ===");
                console.log("Making Okta API call to:", url);
                console.log("From page:", window.location.href);
                console.log("Page title:", document.title);
                console.log("Document ready state:", document.readyState);
                
                try {
                    return fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        }
                    }).then(response => {
                        console.log("Tab-based API Response status:", response.status);
                        console.log("Response headers:", response.headers);
                        
                        if (!response.ok) {
                            console.log("API response not OK, getting response text...");
                            return response.text().then(text => {
                                console.log("Error response text:", text.substring(0, 200));
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
                        console.log("API response OK, parsing JSON...");
                        return response.json().then(data => {
                            console.log("Successfully parsed JSON, data keys:", Object.keys(data));
                            return {
                                success: true,
                                data: data,
                                url: window.location.href,
                                title: document.title
                            };
                        });
                    }).catch(error => {
                        console.log("Fetch error:", error.message);
                        console.log("Error stack:", error.stack);
                        return {
                            success: false,
                            error: error.message,
                            url: window.location.href,
                            title: document.title
                        };
                    });
                } catch (error) {
                    console.log("Script execution error:", error.message);
                    console.log("Error stack:", error.stack);
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
            console.log("Raw API call results:", results);
            
            if (!results || results.length === 0) {
                console.log("No results returned from API call script");
                chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "API call script returned no results"}});
                safeSendMessage({"method": "UpdateOktaApps"});
                if (callback) callback(false);
                return;
            }
            
            const result = results[0]?.result;
            console.log("API call result:", result);
            
            if (!result) {
                console.log("API call script returned null result");
                chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "API call script execution failed"}});
                safeSendMessage({"method": "UpdateOktaApps"});
                if (callback) callback(false);
                return;
            }
            
            if (result.success) {
                chrome.storage.local.set({"okta_apps_status": {"status": "success", "apps": result.data}});
                safeSendMessage({"method": "UpdateOktaApps"});
                
                // Final success notification with app count
                const appCount = result.data.reduce((total, tab) => total + (tab._embedded?.items?.length || 0), 0);
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'Icons/icon_48.png',
                    title: 'AWS Account Switcher',
                    message: `Ready! Loaded ${appCount} applications.`
                });
                
                if (callback) callback(true);
            } else {
                let message = result.status === 403 ? 
                    `Failed to get the list of okta applications. Need to login! (Status: ${result.status}, Page: ${result.title})` : 
                    `Failed to get the list of okta applications. Status: ${result.status || "Unknown"} - ${result.statusText || result.error}`;
                console.log("API call failed:", message);
                if (result.responseText) {
                    console.log("Response details:", result.responseText);
                }
                
                // Always set error status - this helps user understand what happened
                chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": message}});
                safeSendMessage({"method": "UpdateOktaApps"});
                if (callback) callback(false);
            }
            
            if (closeTab) {
                // Small delay before closing tab to ensure response is processed
                setTimeout(() => {
                    chrome.tabs.remove(tabId, () => {
                        if (chrome.runtime.lastError) {
                            console.log("Tab already closed");
                        }
                    });
                }, 100);
            }
        }).catch(error => {
            console.log("Script injection error:", error.message);
            let errorMessage = error.message.includes("Frame with ID") ? 
                "Tab was closed during API call" : 
                "Script injection failed: " + error.message;
            
            // Always set error status - this helps user understand what happened
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": errorMessage}});
            safeSendMessage({"method": "UpdateOktaApps"});
            if (callback) callback(false);
            
            if (closeTab) {
                chrome.tabs.remove(tabId, () => {
                    if (chrome.runtime.lastError) {
                        console.log("Tab already closed");
                    }
                });
            }
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
