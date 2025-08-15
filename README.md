# AWS Account Switcher

A Chrome extension that allows you to easily switch between AWS accounts without repeatedly logging into Okta. This tool streamlines the process of managing multiple AWS accounts through Okta SSO.

## ✨ Features

### 🚀 **Version 5.1.0 - Latest**
- **Manifest V3 Compatible** - Modern Chrome extension architecture
- **Seamless Okta Integration** - Automatic login with CORS workaround
- **Smart Session Detection** - Detects existing Okta sessions
- **Auto-refresh Applications** - Automatically loads Okta apps after login
- **Smooth Animations** - Loading states and transitions
- **Background Tab Login** - Extension popup stays open during login
- **MFA Support** - Handles multi-factor authentication
- **Account Management** - Store, switch, and manage multiple AWS accounts
- **Role Filtering** - Filter accounts by AWS roles
- **Account Expiration** - Track and manage account session expiration

### 🔧 **Core Functionality**
- Switch between AWS accounts with one click
- Store AWS account credentials securely in browser storage
- Automatic account detection and switching
- Support for multiple AWS roles per account
- Account status tracking (active/expired)
- Account expiration functionality that logs out of AWS

## 📦 Installation

### Method 1: Load Unpacked (Developer Mode)
1. **Clone this repository**
   ```bash
   git clone https://github.com/itayvolo/okta-aws-account-switcher.git
   cd okta-aws-account-switcher
   ```

2. **Open Chrome Extensions**
   - Navigate to `chrome://extensions`
   - Or click Chrome menu → Extensions → Manage Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the upper right corner
   
4. **Load the Extension**
   - Click "Load unpacked"
   - Select the repository folder
   - The extension should now appear in your extensions list

5. **Pin the Extension**
   - Click the puzzle piece icon in Chrome toolbar
   - Pin "Okta - AWS Account Switcher" for easy access

## ⚙️ Configuration

### Initial Setup
1. **Click the extension icon** in your Chrome toolbar
2. **Go to Settings tab** (gear icon)
3. **Configure Okta settings:**
   - **Okta Domain**: Your organization's Okta domain (e.g., `company.okta.com`)
   - **Username**: Your Okta username
   - **Password**: Your Okta password

### Okta Application Setup
1. **Login to Okta** using the extension (click the "Login" button)
2. **Wait for "Login successful!"** message to appear
3. **Applications will load automatically** after successful login
4. **Select your AWS application** from the list
5. The selected AWS app will be used for account switching

**Note:** Applications load automatically during the login process. You can also manually refresh them using the "Refresh OKTA Applications" button if needed.

## 🎯 Usage

### Switching AWS Accounts
1. **Get Accounts**: Click to retrieve available AWS accounts from your selected Okta app
2. **Select Account**: Click on any account to switch to it
3. **Account Status**: Green = active, Red = expired/inactive

### Managing Accounts
- **Delete Account**: Click the menu (⋮) next to an account → Delete
- **Expire Account**: Manually expire an active account
- **Delete All**: Remove all stored accounts

### Refresh & Reset
- **Refresh Button**: Reloads the entire extension (clears stuck states)
- **F5 or Ctrl+Shift+R**: Keyboard shortcuts for refresh

## 🔄 What's New in v5.1.0

### Major Updates
- ✅ **Manifest V3 Migration** - Future-proof Chrome extension
- ✅ **CORS Issue Resolution** - Uses tab-based authentication
- ✅ **Auto-refresh Okta Apps** - Apps load automatically after login
- ✅ **Enhanced Animations** - Smooth loading states and transitions
- ✅ **Improved UX** - Extension popup stays open during login

### Technical Improvements
- Replaced XMLHttpRequest with modern Fetch API
- Service Worker architecture for better performance
- Smart existing tab detection and reuse
- Enhanced error handling and user feedback
- Production-ready code with debug logs removed

## 🛠️ Technical Details

### Architecture
- **Manifest Version**: 3
- **Service Worker**: Background script for API calls
- **Content Scripts**: For Okta page interaction
- **Storage**: Chrome local storage for account data
- **Permissions**: Tabs, scripting, storage, cookies, alarms

### Browser Compatibility
- **Chrome**: Version 88+ (Manifest V3 support)
- **Edge**: Version 88+ (Chromium-based)
- **Other Chromium browsers**: Should work with Manifest V3 support

## 🔐 Security & Privacy

- **Local Storage Only**: Account data stored locally in browser
- **No External Servers**: All data remains on your machine
- **Secure Authentication**: Uses Okta's standard authentication flow
- **Password Protection**: Passwords stored in Chrome's secure storage

## 🐛 Troubleshooting

### Common Issues

**Extension shows "unsupported"**
- Make sure you're using Chrome 88+ with Manifest V3 support

**Login fails with CORS errors**
- This is resolved in v5.1.0 with tab-based authentication

**Okta apps not loading**
- Verify your Okta domain is correct
- Check that you have access to AWS applications in Okta
- Try refreshing the applications list

**Accounts not switching**
- Ensure you're logged into AWS in the same browser
- Check account status (expired accounts won't work)
- Try refreshing the extension

### Reset Extension
If you encounter issues, use the **Refresh** button (🔄) in the top-left corner to reset the extension state.

## 🚀 Development

### Project Structure
```
okta-aws-account-switcher/
├── manifest.json          # Extension manifest (v3)
├── background.js          # Service worker
├── popup.html            # Extension popup UI
├── popup.js              # Popup functionality
├── popup.css             # Styles and animations
├── get_accounts.js       # Account retrieval logic
├── Icons/                # Extension icons (icon_48.png)
└── fontawesome/          # FontAwesome icons (CSS + webfonts only)
```

### Building from Source
1. Clone the repository
2. No build step required - it's vanilla JavaScript
3. Load unpacked in Chrome extensions

## 📝 Changelog

### v5.1.0 (Latest)
- ✅ Auto-refresh Okta applications after successful login
- ✅ Added smooth loading animations and transitions
- ✅ Fixed duplicated loading indicators
- ✅ Enhanced user experience with visual feedback
- ✅ Fixed account expiration to actually log out of AWS
- ✅ AWS SSO pages now stay open after account selection
- ✅ Fixed UI layout issues and button text cutoff
- ✅ Enhanced security analysis completed

### v5.0.0
- ✅ Manifest V3 migration
- ✅ CORS issue resolution with tab-based authentication
- ✅ Service Worker architecture
- ✅ Enhanced error handling and debugging
- ✅ Production code cleanup

## 🤝 Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

## 📄 License

This project is provided as-is for internal use. Please ensure compliance with your organization's security policies.

---

**Version**: 5.1.0  
**Last Updated**: 2025
**Chrome Extension**: Manifest V3  
**Status**: ✅ Production Ready
