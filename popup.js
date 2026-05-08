window.addEventListener("load", load_popup);

// Helper function to wake up service worker
function wakeUpServiceWorker() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['_keepalive'], () => {
            resolve();
        });
    });
}

// Helper function to send messages with error handling
async function safeSendMessage(message, retries = 3) {
    await wakeUpServiceWorker();

    try {
        const response = await chrome.runtime.sendMessage(message);
        return response;
    } catch (error) {
        if (error.message && error.message.includes('Could not establish connection') && retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            await wakeUpServiceWorker();
            return safeSendMessage(message, retries - 1);
        } else {
            throw error;
        }
    }
}

// Add keyboard shortcuts
document.addEventListener('keydown', function(event) {
    // Ctrl/Cmd + R to refresh accounts
    if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
        event.preventDefault();
        get_all_accounts();
    }
    // Escape to close any open menus
    if (event.key === 'Escape') {
        closeAllMenus();
    }
});

// Close menus when clicking outside
document.addEventListener('click', function(event) {
    const isMenuButton = event.target.closest('.menu_drop_btn');
    const isMenuContent = event.target.closest('.drop_content');
    const isMenuIcon = event.target.classList.contains('fa-ellipsis-v');

    if (!isMenuButton && !isMenuContent && !isMenuIcon) {
        closeAllMenus();
    }
});

function closeAllMenus() {
    const dropContents = document.querySelectorAll('.drop_content');
    dropContents.forEach(drop => {
        drop.classList.remove('show');
    });
}

function toggleSettings() {
    const settingsSection = document.getElementById('settings_section');
    settingsSection.classList.toggle('collapsed');
}

function collapseSettings() {
    const settingsSection = document.getElementById('settings_section');
    settingsSection.classList.add('collapsed');
}

function expandSettings() {
    const settingsSection = document.getElementById('settings_section');
    settingsSection.classList.remove('collapsed');
}

async function load_popup() {
    try {
        await wakeUpServiceWorker();
    } catch (error) {
        // Service worker connection failed
    }

    // Check if we have accounts and collapse settings immediately (without animation)
    chrome.storage.local.get(["accounts"], function(result) {
        if (result.accounts && Object.keys(result.accounts).length > 0) {
            const settingsSection = document.getElementById('settings_section');
            const collapsibleContent = document.getElementById('settings_content');
            const chevron = document.getElementById('settings_chevron');

            // Temporarily disable all transitions for instant collapse
            settingsSection.style.transition = 'none';
            if (collapsibleContent) collapsibleContent.style.transition = 'none';
            if (chevron) chevron.style.transition = 'none';

            settingsSection.classList.add('collapsed');

            // Re-enable transitions after a frame
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    settingsSection.style.transition = '';
                    if (collapsibleContent) collapsibleContent.style.transition = '';
                    if (chevron) chevron.style.transition = '';
                });
            });
        }
    });

    // Set up event listeners
    document.getElementById('get_accounts').addEventListener("click", get_all_accounts);
    document.getElementById('okta_login').addEventListener("click", okta_login);
    document.getElementById('settings_header').addEventListener("click", toggleSettings);

    // Set up settings input listeners
    document.getElementById("okta_domain").addEventListener("focusout", save_setting);
    document.getElementById("okta_username").addEventListener("focusout", save_setting);
    document.getElementById("okta_password").addEventListener("focusout", save_setting);
    document.getElementById("aws_app_url").addEventListener("focusout", function(e) {
        save_aws_app_url(e);
        e.currentTarget.setAttribute("readonly", "");
    });
    document.getElementById("aws_app_url_edit").addEventListener("click", function(e) {
        e.preventDefault();
        const input = document.getElementById("aws_app_url");
        input.removeAttribute("readonly");
        input.focus();
        input.select();
    });
    document.getElementById("aws_flow_mode").addEventListener("change", save_setting);
    document.getElementById("accounts_load_dismiss").addEventListener("click", function() {
        chrome.storage.local.remove("accounts_status", function() {
            const loadDiv = document.getElementById("accounts_load");
            loadDiv.classList.remove("error");
            loadDiv.style.display = "none";
        });
    });

    // Load saved settings
    chrome.storage.local.get(["settings"], async function(result) {
        if (result.settings === undefined) {
            return;
        }
        document.getElementById("aws_flow_mode").value = result.settings.aws_flow_mode || "access_portal";
        if (result.settings.okta_domain !== undefined) {
            document.getElementById("okta_domain").value = result.settings.okta_domain;
        }
        if (result.settings.okta_username !== undefined) {
            document.getElementById("okta_username").value = result.settings.okta_username;
        }
        // Load and decrypt password if it exists
        if (result.settings.okta_password !== undefined && result.settings.okta_domain) {
            if (window.CryptoUtils && window.CryptoUtils.isEncrypted(result.settings.okta_password)) {
                const decrypted = await window.CryptoUtils.decryptPassword(
                    result.settings.okta_password,
                    result.settings.okta_domain
                );
                if (decrypted) {
                    document.getElementById("okta_password").value = decrypted;
                }
            } else {
                // Password is stored in plaintext (legacy)
                document.getElementById("okta_password").value = result.settings.okta_password;
            }
        }
        // Load AWS app URL if it exists
        if (result.settings.aws_app !== undefined && result.settings.aws_app.url) {
            document.getElementById("aws_app_url").value = result.settings.aws_app.url;
        }
    });

    load_aws_accounts();
    update_login_status();
}

function load_aws_accounts() {
    update_accounts_status();
    var current_account = "";
    var current_role = "";
    chrome.cookies.getAll({"domain": ".amazon.com", "name": "aws-userInfo"}, function(user_info_cookies){
        if (user_info_cookies.length !== 0) {
            for (let i = 0; i < user_info_cookies.length; i++) {
                if (user_info_cookies[i].domain === "amazon.com") {continue;}
                var userInfo = JSON.parse(decodeURIComponent(user_info_cookies[i].value));
                current_account = userInfo.alias;
                current_role = userInfo.arn.split('/')[1];
                break;
            }
        }
        chrome.storage.local.get(["accounts"], (result) => {
            if (result.accounts === undefined) {return}
            const items = result.accounts;
            if (items.length === 0) {return}
            var allKeys = Object.keys(items);

            for (let i = 0; i < allKeys.length; i++) {
                var row_div = document.createElement('div');
                row_div.classList.add("row");

                // Create menu button container with dropdown (on the left)
                var menu_container = document.createElement('div');
                menu_container.style.position = 'relative';
                menu_container.style.display = 'flex';
                menu_container.style.alignItems = 'center';
                row_div.appendChild(menu_container);

                var menu_open_btn = document.createElement('div');
                menu_open_btn.classList.add("menu_drop_btn");
                menu_open_btn.addEventListener("click", toggle_menu);
                menu_container.appendChild(menu_open_btn);

                var menu_icon = document.createElement('i');
                menu_icon.classList.add("fas", "fa-ellipsis-v");
                menu_open_btn.appendChild(menu_icon);

                var account_div = document.createElement('div');
                account_div.classList.add("account");
                account_div.id = allKeys[i];
                account_div.addEventListener("click", account_change);
                row_div.appendChild(account_div);

                var account_name_role_div = document.createElement('div');
                account_name_role_div.id = "account_name_role";
                account_div.appendChild(account_name_role_div);

                var account_name_div = document.createElement('div');
                account_name_div.innerText = allKeys[i].split('/')[0];
                account_name_div.id = "account_name";
                account_name_role_div.appendChild(account_name_div);

                var account_role_div = document.createElement('div');
                account_role_div.id = "account_role";
                account_role_div.innerText = allKeys[i].split('/')[1];
                account_name_role_div.appendChild(account_role_div);

                var info_div = document.createElement('div');
                info_div.id = "status_div";
                account_div.appendChild(info_div);

                var status = items[allKeys[i]].status;
                var status_div = document.createElement('div');
                status_div.id = "status";
                status_div.innerText = status;
                info_div.appendChild(status_div);

                var account_id_div = document.createElement('div');
                account_id_div.classList.add("status");
                account_id_div.innerText = items[allKeys[i]].id;
                info_div.appendChild(account_id_div);

                // Create dropdown menu
                var drop_content = document.createElement('div');
                drop_content.classList.add("drop_content");
                menu_container.appendChild(drop_content);

                var menu_options = document.createElement('div');
                menu_options.classList.add("menu_options");
                drop_content.appendChild(menu_options);

                // Delete option
                var delete_menu_option = document.createElement('div');
                delete_menu_option.classList.add("menu_option", "delete-option");
                delete_menu_option.addEventListener("click", delete_account);
                menu_options.appendChild(delete_menu_option);

                var delete_menu_icon = document.createElement('i');
                delete_menu_icon.classList.add("fa", "fa-trash-alt");
                delete_menu_option.appendChild(delete_menu_icon);

                var delete_menu_text = document.createElement('span');
                delete_menu_text.classList.add("option_text");
                delete_menu_text.innerText = "Delete";
                delete_menu_option.appendChild(delete_menu_text);

                // Expire option (only for ready accounts)
                if (status === "ready") {
                    status_div.classList.add("green");
                    var expire_menu_option = document.createElement('div');
                    expire_menu_option.classList.add("menu_option", "expire-option");
                    expire_menu_option.addEventListener("click", expire_account);
                    menu_options.appendChild(expire_menu_option);

                    var expire_menu_icon = document.createElement('i');
                    expire_menu_icon.classList.add("fa", "fa-clock");
                    expire_menu_option.appendChild(expire_menu_icon);

                    var expire_menu_text = document.createElement('span');
                    expire_menu_text.classList.add("option_text");
                    expire_menu_text.innerText = "Expire";
                    expire_menu_option.appendChild(expire_menu_text);
                } else {
                    status_div.classList.add("red");
                }

                document.getElementById('accounts_div').appendChild(row_div);
            }
        });
    });
}

function account_change(e) {
    if (e.target.closest('.menu_drop_btn') || e.target.closest('.drop_content')) {
        return;
    }

    var target = e.currentTarget;
    var account = target.id;

    if (!account) {
        return;
    }

    safeSendMessage({"method": "changeAccount", "account": account})
        .catch((error) => {
            alert('Failed to switch account. Please try again.');
        });
}

function toggle_menu(e) {
    e.stopPropagation();
    var target = e.currentTarget;
    var drop_div = target.parentElement.querySelector(".drop_content");

    // Close all other menus first
    const allDropdowns = document.querySelectorAll('.drop_content');
    allDropdowns.forEach(dropdown => {
        if (dropdown !== drop_div) {
            dropdown.classList.remove('show');
        }
    });

    // Toggle the clicked menu
    if (drop_div) {
        const isShowing = drop_div.classList.contains('show');
        if (isShowing) {
            drop_div.classList.remove('show');
        } else {
            // Use position: fixed so the dropdown escapes the scrollable
            // accounts container and can extend below its visible area.
            const buttonRect = target.getBoundingClientRect();
            drop_div.style.position = 'fixed';
            drop_div.style.top = (buttonRect.bottom + 4) + 'px';
            drop_div.style.left = buttonRect.left + 'px';
            drop_div.style.right = 'auto';
            drop_div.style.bottom = 'auto';
            drop_div.classList.add('show');
        }
    }
}

function get_all_accounts() {
    const button = document.getElementById('get_accounts');
    const originalText = button.innerText;
    button.innerText = 'Loading...';
    button.disabled = true;
    button.classList.add('loading-state');

    safeSendMessage({"method": "getAllAccounts"});

    setTimeout(() => {
        button.innerText = originalText;
        button.disabled = false;
        button.classList.remove('loading-state');
    }, 10000);
}

function expire_account(e) {
    e.stopPropagation();
    closeAllMenus();
    var account_name = e.currentTarget.closest(".row").querySelector("#account_name").innerText;
    var account_role = e.currentTarget.closest(".row").querySelector("#account_role").innerText;
    var account = account_name + '/' + account_role;

    if (confirm(`Are you sure you want to expire and log out of account "${account_name}"?`)) {
        safeSendMessage({"method": "expireAccount", "account": account})
            .then(() => {
                location.reload();
            })
            .catch((error) => {
                alert('Failed to expire account. Please try again.');
            });
    }
}

function delete_account(e) {
    e.stopPropagation();
    closeAllMenus();
    var account_name = e.currentTarget.closest(".row").querySelector("#account_name").innerText;
    var account_role = e.currentTarget.closest(".row").querySelector("#account_role").innerText;
    var account = account_name + '/' + account_role;
    if (confirm(`Are you sure you want to delete account "${account_name}" with role "${account_role}"?`)) {
        chrome.storage.local.get(["accounts"], function(result) {
            if (result.accounts === undefined) {return}
            if (result.accounts[account] === undefined) {return}
            delete result.accounts[account];
            chrome.storage.local.set(result, function(){location.reload()});
        });
    }
}

chrome.runtime.onMessage.addListener(function(request, _sender, _sendResponse) {
    if (request.method === "UpdatePopup") {
        location.reload();
    }
    else if (request.method === "UpdateLoginStatus") {
        update_login_status();
    }
    else if (request.method === "UpdateAccountsStatus") {
        update_accounts_status();
    }
});

async function save_setting(e) {
    var target = e.currentTarget;
    chrome.storage.local.get(["settings"], async function(result) {
        if (result.settings === undefined) {
            result.settings = {};
        }
        if (target.value !== "") {
            // Always encrypt password
            if (target.id === 'okta_password' && window.CryptoUtils && result.settings.okta_domain) {
                const encrypted = await window.CryptoUtils.encryptPassword(target.value, result.settings.okta_domain);
                if (encrypted) {
                    result.settings[target.id] = encrypted;
                } else {
                    result.settings[target.id] = target.value;
                }
            } else {
                result.settings[target.id] = target.value;
            }
        } else {
            delete result.settings[target.id];
        }
        chrome.storage.local.set(result);
    });
}

function save_aws_app_url(e) {
    var url = e.currentTarget.value;
    chrome.storage.local.get(["settings"], function(result) {
        if (result.settings === undefined) {
            result.settings = {};
        }
        if (url !== "") {
            result.settings.aws_app = {
                label: "AWS",
                url: url
            };
        } else {
            delete result.settings.aws_app;
        }
        chrome.storage.local.set(result);
    });
}

function okta_login() {
    const status_div = document.getElementById("login_status_div");
    const status_span = document.getElementById("login_status");
    const login_button = document.querySelector("button#okta_login");
    const login_button_span = login_button.querySelector("span");

    // Set loading state
    status_div.style.display = "block";
    status_span.innerText = "Starting login...";
    status_span.className = "";
    login_button_span.innerText = "";
    login_button_span.className = "loading-spinner";
    login_button.disabled = true;

    safeSendMessage({"method": "loginOkta"});
}

function update_login_status() {
    chrome.storage.local.get(["login_status"], function(storage) {
        if (storage.login_status === undefined) {return}
        var status_div = document.getElementById("login_status_div");
        var status_span = document.getElementById("login_status");
        var login_button = document.querySelector("button#okta_login");
        var login_button_span = login_button.querySelector("span");

        status_div.style.display = "block";
        status_span.innerText = storage.login_status.message;

        if (storage.login_status.status === "failed") {
            status_span.className = "red";
            login_button_span.innerText = "Login";
            login_button_span.className = "";
            login_button.disabled = false;
        }
        else if (storage.login_status.status === "success") {
            status_span.className = "green";
            login_button_span.innerText = "Login";
            login_button_span.className = "";
            login_button.disabled = false;
        }
        else if (storage.login_status.status === "progress") {
            status_span.className = "";
            login_button_span.innerText = "";
            login_button_span.className = "loading-spinner";
            login_button.disabled = true;
        } else {
            status_span.className = "";
            login_button_span.innerText = "Login";
            login_button_span.className = "";
            login_button.disabled = false;
        }
    });
}

function update_accounts_status() {
    chrome.storage.local.get(["accounts_status"], function(storage) {
        if (storage.accounts_status === undefined) {return}

        const button = document.getElementById('get_accounts');
        const loadDiv = document.getElementById("accounts_load");
        document.getElementById("accounts_load_span").innerText = storage.accounts_status.message;

        if (storage.accounts_status.status === "success") {
            loadDiv.style.display = "none";
            loadDiv.classList.remove("error");
            if (button) {
                button.classList.remove('loading-state');
                button.disabled = false;
                button.innerText = "Get Accounts";
            }
        }
        else if (storage.accounts_status.status === "failed") {
            loadDiv.style.display = "flex";
            loadDiv.classList.add("error");
            if (button) {
                button.classList.remove('loading-state');
                button.disabled = false;
                button.innerText = "Get Accounts";
            }
        }
        else if (storage.accounts_status.status === "progress") {
            loadDiv.style.display = "flex";
            loadDiv.classList.remove("error");
            if (button) {
                button.classList.add('loading-state');
            }
        }
        else {
            loadDiv.style.display = "none";
            loadDiv.classList.remove("error");
            if (button) {
                button.classList.remove('loading-state');
                button.disabled = false;
                button.innerText = "Get Accounts";
            }
        }
    });
}
