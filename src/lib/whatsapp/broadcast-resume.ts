// ============================================================
// Broadcast resume / retry
//
// Responsável por montar o próximo delivery pass.
//
// NÃO envia mensagens diretamente.
//
// O envio é feito por:
//
//   deliverBroadcast()
//
// O delivery é sempre sequencial:
//   1 -> await Meta
//   2 -> await Meta
//   3 -> await Meta
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

export const RESUME_SCOPES: readonly ResumeScope[] =
  [
    'pending',
    'failed',
    'all',
  ];

// ============================================================
// Limits
// ============================================================
//
// Este limite é por PASS.
//
// Não é concorrência.
//
// Exemplo:
//
// 322 recipients
//
// pass 1 -> 50
// pass 2 -> 50
// pass 3 -> 50
// ...
//
// Dentro de cada pass:
// 1 por vez.
// ============================================================

export const RESUME_MAX_PER_REQUEST =
  50;

// ============================================================
// Lock
// ============================================================

export const DELIVERY_LOCK_STALE_MS =
  30 * 60 * 1000;

// ============================================================
// Scope
// ============================================================

function scopeStatuses(
  scope: ResumeScope,
): string[] {
  if (
    scope === 'pending'
  ) {
    return [
      'pending',
    ];
  }

  if (
    scope === 'failed'
  ) {
    return [
      'failed',
    ];
  }

  return [
    'pending',
    'failed',
  ];
}

// ============================================================
// Claim lock
// ============================================================

export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date =
    new Date(),
): Promise<boolean> {
  const staleCutoff =
    new Date(
      now.getTime() -
        DELIVERY_LOCK_STALE_MS,
    ).toISOString();

  const {
    data,
    error,
  } = await db
    .from('broadcasts')
    .update({
      delivery_locked_at:
        now.toISOString(),
    })
    .eq(
      'id',
      broadcastId,
    )
    .eq(
      'account_id',
      accountId,
    )
    .or(
      `delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`,
    )
    .select('id');

  if (error) {
    console.error(
      '[broadcast-resume] claim failed:',
      error.message,
    );

    return false;
  }

  return (
    Array.isArray(data) &&
    data.length > 0
  );
}

// ============================================================
// Release lock
// ============================================================

export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const {
    error,
  } = await db
    .from('broadcasts')
    .update({
      delivery_locked_at:
        null,
    })
    .eq(
      'id',
      broadcastId,
    );

  if (error) {
    console.error(
      '[broadcast-resume] release failed:',
      error.message,
    );
  }
}

// ============================================================
// Resume plan
// ============================================================

export interface ResumePlan {
  plan: BroadcastPlan;

  remaining: number;

  unsendable: number;
}

// ============================================================
// Recipient row
// ============================================================

interface RecipientRow {
  id: string;

  contact_id: string;

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

// ============================================================
// Contact phone
// ============================================================

function contactPhone(
  row: RecipientRow,
): string | null {
  const contact =
    Array.isArray(
      row.contact,
    )
      ? row.contact[0]
      : row.contact;

  return (
    contact?.phone ??
    null
  );
}

// ============================================================
// Plan resume
// ============================================================

export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  broadcastId: string,
  scope: ResumeScope,
): Promise<ResumePlan> {
  // ----------------------------------------------------------
  // Broadcast
  // ----------------------------------------------------------

  const {
    data: broadcast,
    error:
      broadcastError,
  } = await db
    .from('broadcasts')
    .select(
      'id, template_name, template_language, header_media_url',
    )
    .eq(
      'id',
      broadcastId,
    )
    .eq(
      'account_id',
      accountId,
    )
    .maybeSingle();

  if (
    broadcastError ||
    !broadcast
  ) {
    throw new BroadcastError(
      'not_found',
      'Broadcast not found',
      404,
    );
  }

  // ----------------------------------------------------------
  // Recipients
  // ----------------------------------------------------------

  const statuses =
    scopeStatuses(
      scope,
    );

  const {
    data: rawRows,
    error:
      recipientError,
  } = await db
    .from(
      'broadcast_recipients',
    )
    .select(
      'id, contact_id, template_params, contact:contacts(phone)',
    )
    .eq(
      'broadcast_id',
      broadcastId,
    )
    .in(
      'status',
      statuses,
    )
    .order(
      'created_at',
      {
        ascending:
          true,
      },
    );

  if (
    recipientError
  ) {
    console.error(
      '[broadcast-resume] recipient load failed:',
      recipientError.message,
    );

    throw new BroadcastError(
      'internal',
      'Failed to load recipients',
      500,
    );
  }

  const rows =
    (rawRows ?? []) as RecipientRow[];

  // ----------------------------------------------------------
  // Sendable / unsendable
  // ----------------------------------------------------------

  const sendable:
    RecipientRow[] =
    [];

  const unsendableIds:
    string[] =
    [];

  for (
    const row of rows
  ) {
    const phone =
      sanitizePhoneForMeta(
        contactPhone(
          row,
        ) ?? '',
      );

    if (
      isValidE164(
        phone,
      )
    ) {
      sendable.push(
        row,
      );
    } else {
      unsendableIds.push(
        row.id,
      );
    }
  }

  // ----------------------------------------------------------
  // Mark invalid phones
  // ----------------------------------------------------------

  if (
    unsendableIds.length >
    0
  ) {
    const {
      error:
        unsendableError,
    } = await db
      .from(
        'broadcast_recipients',
      )
      .update({
        status:
          'failed',

        error_message:
          'No valid phone number on contact',
      })
      .in(
        'id',
        unsendableIds,
      );

    if (
      unsendableError
    ) {
      console.error(
        '[broadcast-resume] failed marking unsendable recipients:',
        unsendableError.message,
      );
    }
  }

  // ----------------------------------------------------------
  // PASS LIMIT
  // ----------------------------------------------------------

  const slice =
    sendable.slice(
      0,
      RESUME_MAX_PER_REQUEST,
    );

  const remaining =
    Math.max(
      0,
      sendable.length -
        slice.length,
    );

  // ----------------------------------------------------------
  // Nothing to send
  // ----------------------------------------------------------

  if (
    slice.length === 0
  ) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope ===
        'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400,
    );
  }

  // ----------------------------------------------------------
  // WhatsApp config
  // ----------------------------------------------------------

  const {
    data: config,
    error:
      configError,
  } = await db
    .from(
      'whatsapp_config',
    )
    .select('*')
    .eq(
      'account_id',
      accountId,
    )
    .single();

  if (
    configError ||
    !config
  ) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    );
  }

  // ----------------------------------------------------------
  // Template
  // ----------------------------------------------------------

  const resolvedTemplate =
    await resolveTemplateRow(
      db,
      accountId,
      broadcast.template_name,
      broadcast.template_language,
    );

  if (
    resolvedTemplate.malformed
  ) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before resuming.',
      500,
    );
  }

  // ----------------------------------------------------------
  // BroadcastPlan
  // ----------------------------------------------------------

  const plan:
    BroadcastPlan =
    {
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
        decrypt(
          config.access_token,
        ),

      templateRow:
        resolvedTemplate.row,

      headerMediaUrl:
        broadcast.header_media_url ??
        null,

      planned:
        slice.map(
          (
            row,
          ) => ({
            recipientRowId:
              row.id,

            contactId:
              row.contact_id,

            phone:
              sanitizePhoneForMeta(
                contactPhone(
                  row,
                ) ?? '',
              ),

            params:
              Array.isArray(
                row.template_params,
              )
                ? row.template_params.filter(
                    (
                      p,
                    ): p is string =>
                      typeof p ===
                      'string',
                  )
                : [],
          }),
        ),

      rejected:
        0,
    };

  return {
    plan,

    remaining,

    unsendable:
      unsendableIds.length,
  };
}

// ============================================================
// Mark sending
// ============================================================

export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const {
    error,
  } = await db
    .from('broadcasts')
    .update({
      status:
        'sending',

      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'id',
      broadcastId,
    );

  if (error) {
    console.error(
      '[broadcast-resume] failed marking broadcast as sending:',
      error.message,
    );

    throw new BroadcastError(
      'internal',
      'Failed to mark broadcast as sending',
      500,
    );
  }
}