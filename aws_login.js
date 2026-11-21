// AWS federation login, session capture and switching.

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

function login(app, preset, account, callback, alwaysCloseTab, keepTab) {
    debugLog('login called for account:', account);
    chrome.storage.local.get(["accounts"], function(storage){
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Logging in to " + account.replace("/", " (") + ")..."}});
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
            chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Selecting " + account.replace("/", " (") + ")..."}});
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
                                            const keep = alwaysCloseTab ? false : (keepTab || !(s.settings && s.settings.open_tab_on_switch === false));
                                            if (!keep) {
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

function change_account(app, preset, account, newTab){
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
            refresh_all_aws_tabs(preset, newTab);
        });
    });
}

// newTab: also open a fresh console tab even if one is open.
function refresh_all_aws_tabs(preset, newTab) {
    preset = preset || REGION_PRESETS.commercial;
    chrome.storage.local.get(["settings"], function(s) {
        // Default ON: open a fresh console tab when none is open. When OFF we
        // only reload an already-open console tab and never pop a new one.
        const openNewTab = !(s.settings && s.settings.open_tab_on_switch === false);
        chrome.tabs.query({"url": "*://*." + preset.consoleHost + "/*"}, tabs => {
            for (let i = 0; i < tabs.length; i++) {
                chrome.tabs.reload(tabs[i].id);
            }
            if (newTab || (tabs.length === 0 && openNewTab)) {
                chrome.tabs.create({"url": preset.consoleCreateUrl});
            }
            chrome.storage.local.set({"accounts_status": {"status": "success", "message": "🎉 Account changed successfully!"}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            if (tabs.length > 0 && !newTab) {
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
