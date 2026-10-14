import crypto from 'node:crypto'

export function verifyMetaWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.META_APP_SECRET

  if (!secret || !signatureHeader) {
    console.error('[webhook-signature] Missing secret or signature', {
      hasSecret: Boolean(secret),
      hasSignature: Boolean(signatureHeader),
    })
    return false
  }

  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signatureHeader)

  if (!match) {
    console.error('[webhook-signature] Invalid signature format')
    return false
  }

  const received = Buffer.from(match[1], 'hex')

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest()

  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)

  console.info('[webhook-signature] Verification result', {
    valid,
    bodyBytes: rawBody.length,
    environment: process.env.VERCEL_ENV ?? 'unknown',
  })

  return valid
}