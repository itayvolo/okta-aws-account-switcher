// Crypto utilities for secure password storage
// Uses Web Crypto API with AES-GCM encryption

const CRYPTO_ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

// Derive a cryptographic key from a password/domain combination
async function deriveKey(domain) {
    const encoder = new TextEncoder();
    // Use the domain as a base for key derivation
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(domain + '_okta_aws_switcher_v1'),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    // Get or create a salt for this domain
    let salt = await getSalt(domain);
    if (!salt) {
        salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
        await saveSalt(domain, salt);
    }

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: CRYPTO_ALGORITHM, length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

// Get salt from storage
async function getSalt(domain) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['_crypto_salts'], (result) => {
            if (result._crypto_salts && result._crypto_salts[domain]) {
                resolve(new Uint8Array(result._crypto_salts[domain]));
            } else {
                resolve(null);
            }
        });
    });
}

// Save salt to storage
async function saveSalt(domain, salt) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['_crypto_salts'], (result) => {
            const salts = result._crypto_salts || {};
            salts[domain] = Array.from(salt);
            chrome.storage.local.set({ _crypto_salts: salts }, resolve);
        });
    });
}

// Encrypt a password
async function encryptPassword(password, domain) {
    try {
        const key = await deriveKey(domain);
        const encoder = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

        const encryptedData = await crypto.subtle.encrypt(
            { name: CRYPTO_ALGORITHM, iv: iv },
            key,
            encoder.encode(password)
        );

        // Combine IV and encrypted data
        const combined = new Uint8Array(iv.length + encryptedData.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(encryptedData), iv.length);

        // Return as base64 string
        return btoa(String.fromCharCode(...combined));
    } catch (error) {
        console.error('Encryption failed:', error);
        return null;
    }
}

// Decrypt a password
async function decryptPassword(encryptedPassword, domain) {
    try {
        const key = await deriveKey(domain);

        // Decode from base64
        const combined = new Uint8Array(
            atob(encryptedPassword).split('').map(c => c.charCodeAt(0))
        );

        // Extract IV and encrypted data
        const iv = combined.slice(0, IV_LENGTH);
        const encryptedData = combined.slice(IV_LENGTH);

        const decryptedData = await crypto.subtle.decrypt(
            { name: CRYPTO_ALGORITHM, iv: iv },
            key,
            encryptedData
        );

        const decoder = new TextDecoder();
        return decoder.decode(decryptedData);
    } catch (error) {
        console.error('Decryption failed:', error);
        return null;
    }
}

// Check if a string is encrypted (base64 encoded with proper length)
function isEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    try {
        const decoded = atob(value);
        // Encrypted passwords should be at least IV_LENGTH + some data
        return decoded.length > IV_LENGTH;
    } catch {
        return false;
    }
}

// Export functions for use in other scripts
const CryptoUtils = {
    encryptPassword,
    decryptPassword,
    isEncrypted
};

// Export for browser context (popup)
if (typeof window !== 'undefined') {
    window.CryptoUtils = CryptoUtils;
}

// Export for service worker context (background.js)
if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.CryptoUtils = CryptoUtils;
}
