// ============================================================
// Broadcast resume / retry (issue #472).
//
// Recovers broadcasts whose browser-driven delivery stopped
// mid-flight, and supports retrying failed recipients.
//
// The actual sending is delegated to deliverBroadcast() so that
// initial delivery and resume delivery use exactly the same
// per-recipient behavior.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BroadcastError,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';

import { decrypt } from '@/lib/whatsapp/encryption';

import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

import {
  sanitizePhoneForMeta,
  isValidE164,
} from '@/lib/whatsapp/phone-utils';

// ============================================================
// Resume scopes
// ============================================================

export type ResumeScope =
  | 'pending'
  | 'failed'
  | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = [
  'pending',
  'failed',
  'all',
];

// ============================================================
// Limits / lock
// ============================================================

export const RESUME_MAX_PER_REQUEST = 1000;

export const DELIVERY_LOCK_STALE_MS =
  30 * 60 * 1000;

// ============================================================
// Helpers
// ============================================================

function scopeStatuses(
  scope: ResumeScope
): string[] {
  if (scope === 'pending') {
    return ['pending'];
  }

  if (scope === 'failed') {
    return ['failed'];
  }

  return ['pending', 'failed'];
}

// ============================================================
// Delivery lock
// ============================================================

export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date = new Date()
): Promise<boolean> {
  const staleCutoff = new Date(
    now.getTime() - DELIVERY_LOCK_STALE_MS
  ).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({
      delivery_locked_at: now.toISOString(),
    })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(
      `delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`
    )
    .select('id');

  if (error) {
    console.error(
      '[broadcast-resume] claim failed:',
      error.message
    );

    return false;
  }

  return (
    Array.isArray(data) &&
    data.length > 0
  );
}

// ============================================================
// Release delivery lock
// ============================================================

export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({
      delivery_locked_at: null,
    })
    .eq('id', broadcastId);

  if (error) {
    console.error(
      '[broadcast-resume] release failed:',
      error.message
    );
  }
}

// ============================================================
// Resume plan
// ============================================================

export interface ResumePlan {
  plan: BroadcastPlan;

  /**
   * Recipients still waiting after the per-request cap.
   */
  remaining: number;

  /**
   * Recipients that cannot be sent because their contact
   * has no valid phone number.
   */
  unsendable: number;
}

// ============================================================
// Database row
// ============================================================

interface RecipientRow {
  id: string;

  /**
   * Canonical contact associated with the recipient.
   *
   * Required because BroadcastPlan / PlannedRecipient use
   * contactId to preserve the canonical conversation identity.
   */
  contact_id: string;

  /**
   * Frozen template parameters persisted by migration 038.
   */
  template_params: unknown;

  contact:
    | {
        phone?: string | null;
      }
    | {
        phone?: string | null;
      }[]
    | null;
}

// Supabase can return a to-one relationship either as an
// object or as a one-element array.
function contactPhone(
  row: RecipientRow
): string | null {
  const contact = Array.isArray(row.contact)
    ? row.contact[0]
    : row.contact;

  return contact?.phone ?? null;
}

// ============================================================
// Build resume plan
// ============================================================

export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  // ----------------------------------------------------------
  // Load broadcast
  // ----------------------------------------------------------

  const {
    data: broadcast,
    error: broadcastError,
  } = await db
    .from('broadcasts')
    .select(
      'id, template_name, template_language, header_media_url'
    )
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (
    broadcastError ||
    !broadcast
  ) {
    throw new BroadcastError(
      'not_found',
      'Broadcast not found',
      404
    );
  }

  // ----------------------------------------------------------
  // Load recipients
  // ----------------------------------------------------------

  const statuses =
    scopeStatuses(scope);

  const {
    data: rawRows,
    error: recipientError,
  } = await db
    .from('broadcast_recipients')
    .select(
      'id, contact_id, template_params, contact:contacts(phone)'
    )
    .eq('broadcast_id', broadcastId)
    .in('status', statuses)
    .order('created_at', {
      ascending: true,
    });

  if (recipientError) {
    console.error(
      '[broadcast-resume] recipient load failed:',
      recipientError.message
    );

    throw new BroadcastError(
      'internal',
      'Failed to load recipients',
      500
    );
  }

  const rows =
    (rawRows ?? []) as RecipientRow[];

  // ----------------------------------------------------------
  // Separate sendable / unsendable recipients
  // ----------------------------------------------------------

  const sendable: RecipientRow[] = [];

  const unsendableIds: string[] = [];

  for (const row of rows) {
    const phone =
      sanitizePhoneForMeta(
        contactPhone(row) ?? ''
      );

    if (isValidE164(phone)) {
      sendable.push(row);
    } else {
      unsendableIds.push(row.id);
    }
  }

  // ----------------------------------------------------------
  // Mark recipients without valid phone as failed
  // ----------------------------------------------------------

  if (unsendableIds.length > 0) {
    const {
      error: unsendableError,
    } = await db
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message:
          'No valid phone number on contact',
      })
      .in('id', unsendableIds);

    if (unsendableError) {
      console.error(
        '[broadcast-resume] failed to mark unsendable recipients:',
        unsendableError.message
      );
    }
  }

  // ----------------------------------------------------------
  // Apply resume cap
  // ----------------------------------------------------------

  const slice = sendable.slice(
    0,
    RESUME_MAX_PER_REQUEST
  );

  const remaining =
    sendable.length - slice.length;

  // ----------------------------------------------------------
  // Nothing to send
  // ----------------------------------------------------------

  if (slice.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400
    );
  }

  // ----------------------------------------------------------
  // WhatsApp configuration
  // ----------------------------------------------------------

  const {
    data: config,
    error: configError,
  } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (
    configError ||
    !config
  ) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // ----------------------------------------------------------
  // Resolve template
  // ----------------------------------------------------------

  const resolvedTemplate =
    await resolveTemplateRow(
      db,
      accountId,
      broadcast.template_name,
      broadcast.template_language
    );

  if (
    resolvedTemplate.malformed
  ) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before resuming.',
      500
    );
  }

  // ----------------------------------------------------------
  // Build BroadcastPlan
  // ----------------------------------------------------------

  const plan: BroadcastPlan = {
    broadcastId,

    accountId,

    auditUserId,

    templateName:
      broadcast.template_name,

    templateLanguage:
      resolvedTemplate.language,

    phoneNumberId:
      config.phone_number_id,

    accessToken:
      decrypt(config.access_token),

    templateRow:
      resolvedTemplate.row,

    /**
     * Preserve the campaign-level media URL that was frozen
     * when the broadcast was originally created.
     *
     * This is important because a resume must reproduce the
     * original campaign, not depend on whatever media URL may
     * currently be configured on the template.
     */
    headerMediaUrl:
      broadcast.header_media_url ?? null,

    planned: slice.map((row) => ({
      recipientRowId:
        row.id,

      /**
       * Preserve canonical contact identity so the delivery
       * layer can resolve the same conversation relationship.
       */
      contactId:
        row.contact_id,

      phone:
        sanitizePhoneForMeta(
          contactPhone(row) ?? ''
        ),

      /**
       * Migration 038 freezes the template parameters per
       * recipient. This allows a resume to send exactly the
       * same {{1}}, {{2}}, etc. values as the original pass.
       */
      params:
        Array.isArray(row.template_params)
          ? row.template_params.filter(
              (
                p
              ): p is string =>
                typeof p === 'string'
            )
          : [],
    })),

    rejected: 0,
  };

  return {
    plan,
    remaining,
    unsendable:
      unsendableIds.length,
  };
}

// ============================================================
// Mark broadcast as sending
// ============================================================

export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({
      status: 'sending',
      updated_at:
        new Date().toISOString(),
    })
    .eq('id', broadcastId);

  if (error) {
    console.error(
      '[broadcast-resume] failed to mark broadcast as sending:',
      error.message
    );

    throw new BroadcastError(
      'internal',
      'Failed to mark broadcast as sending',
      500
    );
  }
}