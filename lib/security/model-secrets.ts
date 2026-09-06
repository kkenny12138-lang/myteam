/** 模型密钥的 AES-256-GCM 加解密，仅在服务端使用。 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function masterSecret(): string {
  const value = process.env.MODEL_CONFIG_MASTER_KEY || process.env.DB_PASSWORD || '';
  if (!value) throw new Error('缺少 MODEL_CONFIG_MASTER_KEY，无法加解密模型 API Key');
  return value;
}

async function cryptoKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(masterSecret()));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function encryptModelSecret(value: string): Promise<string> {
  if (!value) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new Uint8Array(encoder.encode(value)));
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(encrypted))}`;
}

export async function decryptModelSecret(value: string): Promise<string> {
  if (!value) return '';
  const [version, iv, encrypted] = value.split(':');
  if (version !== 'v1' || !iv || !encrypted) throw new Error('模型密钥密文格式无效');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await cryptoKey(), fromBase64(encrypted));
  return decoder.decode(plain);
}
