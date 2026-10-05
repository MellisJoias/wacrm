'use client';

import {
  useEffect,
  useState,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  MessageCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: {
    phone: string;
    name?: string;
  }[];
}

interface WhatsAppConfig {
  id: string;
  display_name: string | null;
  phone_number_id: string;
  status: string | null;
}

interface Step4Props {
  name: string;
  onNameChange: (
    name: string,
  ) => void;

  template: MessageTemplate;

  audience: AudienceConfig;

  whatsappConfigs: WhatsAppConfig[];

  whatsappConfigId: string;

  onWhatsappConfigChange: (
    id: string,
  ) => void;

  onSend: () => void;

  onSaveDraft?: () => void;

  onBack: () => void;

  isProcessing: boolean;

  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  whatsappConfigs,
  whatsappConfigId,
  onWhatsappConfigChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t =
    useTranslations(
      'Broadcasts.wizard',
    );

  const [
    showConfirm,
    setShowConfirm,
  ] = useState(false);

  const [
    estimatedReach,
    setEstimatedReach,
  ] = useState<number>(0);

  const [
    loadingReach,
    setLoadingReach,
  ] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);

      try {
        const supabase =
          createClient();

        if (
          audience.type === 'all'
        ) {
          const { count } =
            await supabase
              .from('contacts')
              .select(
                '*',
                {
                  count:
                    'exact',
                  head: true,
                },
              );

          setEstimatedReach(
            count ?? 0,
          );
        } else if (
          audience.type ===
            'tags' &&
          audience.tagIds &&
          audience.tagIds.length >
            0
        ) {
          const {
            data: contactTags,
          } = await supabase
            .from('contact_tags')
            .select(
              'contact_id',
            )
            .in(
              'tag_id',
              audience.tagIds,
            );

          const uniqueIds =
            new Set(
              (
                contactTags ??
                []
              ).map(
                (ct) =>
                  ct.contact_id,
              ),
            );

          setEstimatedReach(
            uniqueIds.size,
          );
        } else if (
          audience.type ===
            'csv' &&
          audience.csvContacts
        ) {
          setEstimatedReach(
            audience.csvContacts
              .length,
          );
        } else {
          setEstimatedReach(
            0,
          );
        }
      } finally {
        setLoadingReach(
          false,
        );
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t(
          'scheduleSend.audienceAll',
        )
      : audience.type === 'tags'
        ? t(
            'scheduleSend.audienceTags',
          )
        : audience.type === 'csv'
          ? t(
              'scheduleSend.audienceCsv',
            )
          : t(
              'scheduleSend.audienceField',
            );

  const selectedWhatsApp =
    whatsappConfigs.find(
      (config) =>
        config.id ===
        whatsappConfigId,
    );

  const canSend =
    Boolean(
      name.trim() &&
        whatsappConfigId &&
        whatsappConfigs.length >
          0,
    );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t(
            'scheduleSend.title',
          )}
        </h2>

        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'scheduleSend.subtitle',
          )}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t(
            'scheduleSend.broadcastName',
          )}
        </label>

        <Input
          value={name}
          onChange={(e) =>
            onNameChange(
              e.target.value,
            )
          }
          placeholder={t(
            'scheduleSend.broadcastNamePlaceholder',
          )}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* WhatsApp Selection */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          WhatsApp para envio
        </label>

        {whatsappConfigs.length ===
        0 ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-foreground">
              Nenhum WhatsApp conectado
            </p>

            <p className="mt-1 text-xs text-muted-foreground">
              Conecte um WhatsApp antes de
              realizar o disparo
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {whatsappConfigs.map(
              (config) => {
                const selected =
                  config.id ===
                  whatsappConfigId;

                const displayName =
                  config.display_name?.trim() ||
                  'WhatsApp';

                return (
                  <button
                    key={config.id}
                    type="button"
                    onClick={() =>
                      onWhatsappConfigChange(
                        config.id,
                      )
                    }
                    disabled={
                      isProcessing
                    }
                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-card hover:bg-muted/50'
                    }`}
                  >
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${
                        selected
                          ? 'border-primary bg-primary/10'
                          : 'border-border bg-muted'
                      }`}
                    >
                      <MessageCircle
                        className={`h-5 w-5 ${
                          selected
                            ? 'text-primary'
                            : 'text-muted-foreground'
                        }`}
                      />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {displayName}
                        </p>

                        {config.status ===
                          'connected' && (
                          <span className="shrink-0 text-xs text-primary">
                            Conectado
                          </span>
                        )}
                      </div>

                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        ID: {config.phone_number_id}
                      </p>
                    </div>

                    <div
                      className={`h-4 w-4 shrink-0 rounded-full border ${
                        selected
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground'
                      }`}
                    >
                      {selected && (
                        <div className="m-1 h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                      )}
                    </div>
                  </button>
                );
              },
            )}
          </div>
        )}

        {selectedWhatsApp && (
          <p className="mt-2 text-xs text-muted-foreground">
            Enviando pelo WhatsApp:{' '}
            <span className="font-medium text-foreground">
              {selectedWhatsApp.display_name ||
                'WhatsApp'}
            </span>
          </p>
        )}
      </div>

      {/* Summary Card */}
      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <p className="text-sm font-medium text-foreground">
          {t(
            'scheduleSend.summary',
          )}
        </p>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">
              {t(
                'scheduleSend.template',
              )}
            </p>

            <p className="text-foreground">
              {template.name}
            </p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">
              {t(
                'scheduleSend.audience',
              )}
            </p>

            <p className="text-foreground">
              {audienceLabel}
            </p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">
              Estimated Reach
            </p>

            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />

                  <p className="font-medium text-foreground">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">
              Language
            </p>

            <p className="text-foreground">
              {template.language ??
                'en_US'}
            </p>
          </div>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />

              <p className="text-sm font-medium text-foreground">
                {t(
                  'scheduleSend.sending',
                )}
              </p>
            </div>

            <span className="text-xs font-medium text-primary">
              {progress}%
            </span>
          </div>

          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{
                width: `${progress}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />

          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={
                onSaveDraft
              }
              disabled={
                !name.trim() ||
                isProcessing
              }
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />

              {t(
                'scheduleSend.saveDraft',
              )}
            </Button>
          )}

          <Dialog
            open={showConfirm}
            onOpenChange={
              setShowConfirm
            }
          >
            <DialogTrigger
              render={
                <Button
                  disabled={
                    !canSend ||
                    isProcessing
                  }
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />

              {t(
                'scheduleSend.sendNow',
              )}
            </DialogTrigger>

            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  Confirm Broadcast
                </DialogTitle>

                <DialogDescription className="text-muted-foreground">
                  You are about to send
                  this broadcast to{' '}
                  <span className="font-medium text-popover-foreground">
                    {estimatedReach.toLocaleString()}
                  </span>{' '}
                  contacts using the{' '}
                  <span className="font-medium text-popover-foreground">
                    {template.name}
                  </span>{' '}
                  template
                  {selectedWhatsApp && (
                    <>
                      {' '}
                      pelo WhatsApp{' '}
                      <span className="font-medium text-popover-foreground">
                        {selectedWhatsApp.display_name ||
                          'WhatsApp'}
                      </span>
                    </>
                  )}
                  . This action
                  cannot be undone.
                </DialogDescription>
              </DialogHeader>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() =>
                    setShowConfirm(
                      false,
                    )
                  }
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>

                <Button
                  disabled={
                    !canSend
                  }
                  onClick={() => {
                    setShowConfirm(
                      false,
                    );

                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />

                  {t(
                    'scheduleSend.sendNow',
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}