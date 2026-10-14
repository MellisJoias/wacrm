import crypto from ‘node:crypto’

export function verifyMetaWebhookSignature(
rawBody: string,
signatureHeader: string | null,
): boolean {
const secret = process.env.META_APP_SECRET

if (!secret) {
console.error(’[webhook-signature] REJECTED: missing META_APP_SECRET’, {
bodyLength: Buffer.byteLength(rawBody, ‘utf8’),
environment: process.env.VERCEL_ENV ?? ‘unknown’,
})
return false
}

if (!signatureHeader) {
console.warn(’[webhook-signature] REJECTED: missing signature header’, {
bodyLength: Buffer.byteLength(rawBody, ‘utf8’),
})
return false
}

if (!signatureHeader.startsWith(‘sha256=’)) {
console.warn(’[webhook-signature] REJECTED: invalid signature format’, {
prefix: signatureHeader.slice(0, 10),
signatureLength: signatureHeader.length,
})
return false
}

const receivedHex = signatureHeader.slice(‘sha256=’.length)

if (!/^[a-fA-F0-9]{64}$/.test(receivedHex)) {
console.warn(’[webhook-signature] REJECTED: malformed SHA-256 signature’, {
signatureLength: signatureHeader.length,
hexLength: receivedHex.length,
})
return false
}

const expectedHex = crypto
.createHmac(‘sha256’, secret)
.update(rawBody, ‘utf8’)
.digest(‘hex’)

const received = Buffer.from(receivedHex, ‘hex’)
const expected = Buffer.from(expectedHex, ‘hex’)

const valid =
received.length === expected.length &&
crypto.timingSafeEqual(received, expected)

console.info(’[webhook-signature] Verification result’, {
valid,
bodyBytes: Buffer.byteLength(rawBody, ‘utf8’),
signatureFormat: ‘sha256’,
environment: process.env.VERCEL_ENV ?? ‘unknown’,
})

if (!valid) {
console.warn(’[webhook-signature] REJECTED: HMAC mismatch’, {
bodyBytes: Buffer.byteLength(rawBody, ‘utf8’),
environment: process.env.VERCEL_ENV ?? ‘unknown’,
hint: ‘Check app secret, Meta app identity, and raw request body.’,
})
}

return valid
}