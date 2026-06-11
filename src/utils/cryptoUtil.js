/**
 * Chiffrement AES-256-GCM pour les secrets sensibles (twoFaSecret).
 * Nécessite TOTP_ENCRYPTION_KEY = 64 caractères hex (32 octets).
 * Format stocké : "enc:<base64(iv+tag+données)>"
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:';

function getKey() {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw || raw.length < 64) throw new Error('TOTP_ENCRYPTION_KEY manquant ou invalide (64 hex requis)');
  return Buffer.from(raw.slice(0, 64), 'hex');
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(stored) {
  // Compatibilité : si le secret n'est pas chiffré (ancien format), retourner tel quel
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  try {
    const key = getKey();
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final('utf8');
  } catch {
    return stored; // fallback sur l'original si déchiffrement échoue
  }
}

const encryptionActive = () => !!process.env.TOTP_ENCRYPTION_KEY;

module.exports = { encrypt, decrypt, encryptionActive };
