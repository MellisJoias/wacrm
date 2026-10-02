// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// With multiple WhatsApp numbers, the conversation identity is:
//
//   account_id + whatsapp_config_id + contact_id
//
// This allows the same contact to have separate conversations for
// different WhatsApp numbers belonging to the same account.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// account_id-tenancy / user_id-audit split) while making the WhatsApp
// configuration explicit.
//
// Audit user: created rows need a NOT NULL `user_id`. As with the
// webhook (where there's no logged-in human either), we attribute
// them to the WhatsApp config owner — a stable account-level default.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId` and the selected WhatsApp configuration.
 *
 * Throws `SendMessageError` on:
 * - invalid phone
 * - missing/invalid WhatsApp config
 * - audit-user resolution failure
 * - database failures
 */
export async function resolveConversationByPhone(
  db: SupabaseClient,
  accountId: string,
  whatsappConfigId: string,
  phone: string,
  name?: string | null
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);

  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  if (!whatsappConfigId) {
    throw new SendMessageError(
      'bad_request',
      'whatsapp_config_id is required',
      400
    );
  }

  // Validate that the selected WhatsApp configuration belongs to this
  // account. Never select an arbitrary config when an account has more
  // than one WhatsApp number.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('id', whatsappConfigId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (configError) {
    console.error(
      '[resolve-conversation] WhatsApp config lookup error:',
      configError
    );

    throw new SendMessageError(
      'db_error',
      'Failed to resolve WhatsApp configuration',
      500
    );
  }

  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp configuration not found for this account.',
      400
    );
  }

  // Audit user for created rows = the account-wide default used by
  // public-API writes (see resolveAuditUserId), so a contact created
  // here is attributed identically to one created via
  // POST /api/v1/contacts.
  //
  // resolveAuditUserId throws ContactError only if the owner can't be
  // resolved — remap it to the SendMessageError family that callers
  // already handle.
  let ownerUserId: string;

  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }

    throw err;
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, accountId, sanitized);

  if (existing) {
    contactId = existing.id;

    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({
          name,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: sanitized,
        name: name || sanitized,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      // Lost a race against a concurrent inbound/API create — the
      // unique index (migration 022) rejected the duplicate. Re-resolve.
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(
          db,
          accountId,
          sanitized
        );

        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError(
            'db_error',
            'Failed to create contact',
            500
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr
        );

        throw new SendMessageError(
          'db_error',
          'Failed to create contact',
          500
        );
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // Conversation identity is now:
  //
  //   (account_id, whatsapp_config_id, contact_id)
  //
  // Order oldest-first and take one row rather than `.maybeSingle()`.
  // This also handles legacy duplicate rows that may exist before the
  // channel-aware unique index is applied.
  const conversationId = await findOrCreateConversationRow(
    db,
    accountId,
    whatsappConfigId,
    contactId,
    ownerUserId
  );

  return {
    conversationId,
    contactId,
    contactCreated,
  };
}

/**
 * Find (oldest-first) or create the conversation for:
 *
 *   (accountId, whatsappConfigId, contactId)
 *
 * Handles the unique-index race the same way the inbound webhook does:
 * on a 23505 from a concurrent create, re-resolve the winning row rather
 * than failing the send.
 */
async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  whatsappConfigId: string,
  contactId: string,
  ownerUserId: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('whatsapp_config_id', whatsappConfigId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error(
      '[resolve-conversation] conversation lookup error:',
      findErr
    );

    throw new SendMessageError(
      'db_error',
      'Failed to resolve conversation',
      500
    );
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('whatsapp_config_id', whatsappConfigId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }

    console.error(
      '[resolve-conversation] conversation create error:',
      convErr
    );

    throw new SendMessageError(
      'db_error',
      'Failed to create conversation',
      500
    );
  }

  return newConv.id;
}