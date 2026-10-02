'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  Plus,
  MessageCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();

  const {
    user,
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);

  // Multi-WhatsApp state.
  const [configs, setConfigs] = useState<WhatsAppConfigType[]>([]);
  const [selectedConfigId, setSelectedConfigId] =
    useState<string | null>(null);
  const [config, setConfig] =
    useState<WhatsAppConfigType | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] =
    useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] =
    useState<string>('');

  const loadedAccountIdRef =
    useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  const [mirrorMedia, setMirrorMedia] = useState(true);
  const [savingMirror, setSavingMirror] = useState(false);

  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError =
    config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] =
    useState(false);

  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };

  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  function clearForm() {
    setConfig(null);
    setPhoneNumberId('');
    setWabaId('');
    setAccessToken('');
    setVerifyToken('');
    setPin('');
    setTokenEdited(false);
    setMirrorMedia(true);
    setRegistrationProbe(null);
    setConnectionStatus('disconnected');
    setResetReason(null);
    setStatusMessage('');
  }

  function hydrateConfig(
    selected: WhatsAppConfigType | null,
  ) {
    if (!selected) {
      clearForm();
      return;
    }

    setConfig(selected);
    setPhoneNumberId(
      selected.phone_number_id || '',
    );
    setWabaId(selected.waba_id || '');
    setAccessToken(MASKED_TOKEN);
    setVerifyToken('');
    setPin('');
    setTokenEdited(false);
    setMirrorMedia(
      selected.mirror_inbound_media !== false,
    );
    setRegistrationProbe(null);
    setResetReason(null);
    setStatusMessage('');
  }

  const verifySelectedConfig = useCallback(
    async (selected: WhatsAppConfigType) => {
      try {
        const res = await fetch(
          `/api/whatsapp/config?whatsapp_config_id=${encodeURIComponent(
            selected.id,
          )}`,
          {
            method: 'GET',
          },
        );

        const payload = await res.json();

        if (payload.connected) {
          setConnectionStatus('connected');
          setResetReason(null);
          setStatusMessage('');
        } else {
          setConnectionStatus('disconnected');
          setResetReason(
            payload.needs_reset
              ? 'token_corrupted'
              : payload.reason === 'meta_api_error'
                ? 'meta_api_error'
                : null,
          );
          setStatusMessage(
            payload.message || '',
          );
        }
      } catch (err) {
        console.error(
          'Health check failed:',
          err,
        );
        setConnectionStatus('disconnected');
      }
    },
    [],
  );

  const fetchConfig = useCallback(
    async (
      acctId: string,
      preferredConfigId?: string | null,
    ) => {
      setLoading(true);

      try {
        const { data, error } =
          await supabase
            .from('whatsapp_config')
            .select('*')
            .eq('account_id', acctId)
            .order('created_at', {
              ascending: true,
            });

        if (error) {
          console.error(
            'Failed to load WhatsApp configs:',
            error,
          );

          toast.error(
            'Failed to load WhatsApp configuration',
          );

          setConfigs([]);
          clearForm();
          return;
        }

        const loadedConfigs =
          (data ?? []) as WhatsAppConfigType[];

        setConfigs(loadedConfigs);

        if (loadedConfigs.length === 0) {
          setSelectedConfigId(null);
          setAddingNew(false);
          clearForm();
          return;
        }

        const currentId =
          preferredConfigId &&
          loadedConfigs.some(
            (item) =>
              item.id === preferredConfigId,
          )
            ? preferredConfigId
            : selectedConfigId &&
                loadedConfigs.some(
                  (item) =>
                    item.id ===
                    selectedConfigId,
                )
              ? selectedConfigId
              : loadedConfigs[0].id;

        const selected =
          loadedConfigs.find(
            (item) =>
              item.id === currentId,
          ) ?? loadedConfigs[0];

        setSelectedConfigId(selected.id);
        setAddingNew(false);
        hydrateConfig(selected);

        await verifySelectedConfig(
          selected,
        );
      } catch (err) {
        console.error(
          'fetchConfig error:',
          err,
        );

        toast.error(
          'Failed to load WhatsApp configuration',
        );
      } finally {
        setLoading(false);
      }
    },
    [
      supabase,
      selectedConfigId,
      verifySelectedConfig,
    ],
  );

  useEffect(() => {
    if (
      authLoading ||
      profileLoading
    ) {
      return;
    }

    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }

    if (
      loadedAccountIdRef.current ===
      accountId
    ) {
      return;
    }

    loadedAccountIdRef.current =
      accountId;

    fetchConfig(accountId);
  }, [
    authLoading,
    profileLoading,
    user?.id,
    accountId,
    fetchConfig,
  ]);

  function handleSelectConfig(
    configId: string,
  ) {
    const selected =
      configs.find(
        (item) =>
          item.id === configId,
      ) ?? null;

    if (!selected) {
      return;
    }

    setSelectedConfigId(selected.id);
    setAddingNew(false);
    hydrateConfig(selected);
    void verifySelectedConfig(
      selected,
    );
  }

  function handleAddNew() {
    setSelectedConfigId(null);
    setAddingNew(true);
    clearForm();
  }

  async function handleToggleMirrorMedia(
    next: boolean,
  ) {
    if (
      !config ||
      !accountId ||
      savingMirror
    ) {
      return;
    }

    const previous = mirrorMedia;

    setMirrorMedia(next);
    setSavingMirror(true);

    try {
      const { error } =
        await supabase
          .from('whatsapp_config')
          .update({
            mirror_inbound_media: next,
          })
          .eq('id', config.id)
          .eq('account_id', accountId);

      if (error) {
        throw new Error(error.message);
      }

      setConfig({
        ...config,
        mirror_inbound_media: next,
      });

      setConfigs((current) =>
        current.map((item) =>
          item.id === config.id
            ? {
                ...item,
                mirror_inbound_media:
                  next,
              }
            : item,
        ),
      );
    } catch (error) {
      console.error(
        'Failed to update media retention setting:',
        error,
      );

      setMirrorMedia(previous);

      toast.error(
        t('mirrorInboundSaveFailed'),
      );
    } finally {
      setSavingMirror(false);
    }
  }

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error(
        'Phone Number ID is required',
      );
      return;
    }

    if (
      addingNew &&
      (!accessToken.trim() ||
        !tokenEdited ||
        accessToken === MASKED_TOKEN)
    ) {
      toast.error(
        'Access Token is required for a new WhatsApp configuration',
      );
      return;
    }

    if (
      !addingNew &&
      config &&
      (!tokenEdited ||
        !accessToken.trim() ||
        accessToken === MASKED_TOKEN)
    ) {
      toast.error(
        'Please re-enter the Access Token to save changes',
      );
      return;
    }

    try {
      setSaving(true);

      const payload: Record<
        string,
        unknown
      > = {
        phone_number_id:
          phoneNumberId.trim(),
        waba_id:
          wabaId.trim() || null,
        verify_token:
          verifyToken.trim() || null,
        pin:
          pin.trim() || null,
      };

      if (addingNew) {
        payload.create_new = true;
      } else if (config) {
        payload.whatsapp_config_id =
          config.id;
      }

      if (
        tokenEdited &&
        accessToken !== MASKED_TOKEN &&
        accessToken.trim()
      ) {
        payload.access_token =
          accessToken.trim();
      }

      const res = await fetch(
        '/api/whatsapp/config',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify(payload),
        },
      );

      const data = await res.json();

      if (!res.ok) {
        toast.error(
          data.error ||
            'Failed to save configuration',
        );
        return;
      }

      if (
        data.registered === false &&
        data.registration_error
      ) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          {
            duration: 12000,
          },
        );
      } else if (
        data.registration_skipped
      ) {
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          {
            duration: 10000,
          },
        );

        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.',
        );

        setPin('');
      }

      if (accountId) {
        await fetchConfig(
          accountId,
          data.whatsapp_config_id,
        );
      }
    } catch (err) {
      console.error(
        'Save error:',
        err,
      );

      toast.error(
        'Failed to save configuration',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!config) {
      return;
    }

    try {
      setTesting(true);

      const res = await fetch(
        `/api/whatsapp/config?whatsapp_config_id=${encodeURIComponent(
          config.id,
        )}`,
        {
          method: 'GET',
        },
      );

      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');

        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful',
        );
      } else {
        setConnectionStatus(
          'disconnected',
        );

        setResetReason(
          payload.needs_reset
            ? 'token_corrupted'
            : payload.reason ===
                'meta_api_error'
              ? 'meta_api_error'
              : null,
        );

        setStatusMessage(
          payload.message || '',
        );

        toast.error(
          payload.message ||
            'API connection failed',
        );
      }
    } catch (err) {
      console.error(
        'Test connection error:',
        err,
      );

      setConnectionStatus(
        'disconnected',
      );

      toast.error(
        'Connection test failed. Check network and try again.',
      );
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    if (!config) {
      return;
    }

    setVerifyingRegistration(true);
    setRegistrationProbe(null);

    try {
      const res = await fetch(
        `/api/whatsapp/config/verify-registration?whatsapp_config_id=${encodeURIComponent(
          config.id,
        )}`,
        {
          method: 'GET',
        },
      );

      const data =
        (await res.json()) as RegistrationProbe;

      setRegistrationProbe(data);

      if (data.live) {
        toast.success(
          'Number is fully wired — Meta is delivering events.',
        );
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          {
            duration: 8000,
          },
        );
      }

      if (accountId) {
        await fetchConfig(
          accountId,
          config.id,
        );
      }
    } catch (err) {
      console.error(
        'verify-registration failed:',
        err,
      );

      toast.error(
        'Could not reach the verification endpoint.',
      );
    } finally {
      setVerifyingRegistration(
        false,
      );
    }
  }

  async function handleReset() {
    if (!config) {
      return;
    }

    if (
      !confirm(
        'This will delete the selected WhatsApp config so you can re-enter it. Continue?',
      )
    ) {
      return;
    }

    try {
      setResetting(true);

      const res = await fetch(
        `/api/whatsapp/config?whatsapp_config_id=${encodeURIComponent(
          config.id,
        )}`,
        {
          method: 'DELETE',
        },
      );

      const data = await res.json();

      if (!res.ok) {
        toast.error(
          data.error ||
            'Failed to reset configuration',
        );
        return;
      }

      toast.success(
        'Configuration cleared. You can now add or configure another WhatsApp number.',
      );

      if (accountId) {
        await fetchConfig(
          accountId,
          null,
        );
      }
    } catch (err) {
      console.error(
        'Reset error:',
        err,
      );

      toast.error(
        'Failed to reset configuration',
      );
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(
      webhookUrl,
    );

    toast.success(
      'Webhook URL copied to clipboard',
    );
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t('title')}
          description={t('description')}
        />

        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner =
    resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-foreground">
                    WhatsApp
                  </CardTitle>

                  <CardDescription className="text-muted-foreground">
                    {configs.length === 0
                      ? 'Nenhum WhatsApp configurado.'
                      : `${configs.length} WhatsApp${
                          configs.length > 1
                            ? 's'
                            : ''
                        } configurado${
                          configs.length > 1
                            ? 's'
                            : ''
                        }.`}
                  </CardDescription>
                </div>

                {canEditSettings && (
                  <Button
                    onClick={
                      handleAddNew
                    }
                    size="sm"
                    variant="outline"
                    className="border-border text-foreground hover:bg-muted"
                  >
                    <Plus className="size-4" />
                    Adicionar WhatsApp
                  </Button>
                )}
              </div>
            </CardHeader>

            {configs.length > 0 && (
              <CardContent className="pt-0">
                <div className="grid gap-2">
                  {configs.map((item) => {
                    const selected =
                      item.id ===
                      selectedConfigId;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() =>
                          handleSelectConfig(
                            item.id,
                          )
                        }
                        className={`flex w-full items-center justify-between rounded-md border p-3 text-left transition-colors ${
                          selected
                            ? 'border-primary bg-primary/5'
                            : 'border-border bg-muted/30 hover:bg-muted'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                            <MessageCircle className="size-4 text-primary" />
                          </div>

                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {item.phone_number_id}
                            </p>

                            <p className="truncate text-xs text-muted-foreground">
                              {item.phone_number_id}
                            </p>
                          </div>
                        </div>

                        <div className="ml-3 shrink-0">
                          {item.status ===
                          'connected' ? (
                            <span className="flex items-center gap-1 text-xs text-emerald-400">
                              <CheckCircle2 className="size-3.5" />
                              Conectado
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <XCircle className="size-3.5" />
                              Desconectado
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            )}

            {addingNew && (
              <CardContent
                className={
                  configs.length > 0
                    ? 'pt-0'
                    : ''
                }
              >
                <Alert className="border-primary/30 bg-primary/5">
                  <Plus className="size-4" />

                  <AlertTitle>
                    Novo WhatsApp
                  </AlertTitle>

                  <AlertDescription>
                    Preencha as credenciais abaixo e salve para adicionar este número à conta.
                  </AlertDescription>
                </Alert>
              </CardContent>
            )}
          </Card>

          {showResetBanner && (
            <Alert className="bg-amber-950/40 border-amber-600/40">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />

                <div className="flex-1">
                  <AlertTitle className="text-amber-200 mb-1">
                    Stored token can&apos;t be decrypted
                  </AlertTitle>

                  <AlertDescription className="text-amber-100/80 text-sm">
                    {statusMessage}
                  </AlertDescription>

                  <Button
                    onClick={handleReset}
                    disabled={resetting}
                    size="sm"
                    className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    {resetting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        {t('resetting')}
                      </>
                    ) : (
                      <>
                        <RotateCcw className="size-4" />
                        {t('resetConfig')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </Alert>
          )}

          {config && (
            <>
              <Alert className="bg-card border-border">
                <div className="flex items-center gap-2">
                  {connectionStatus ===
                  'connected' ? (
                    <CheckCircle2 className="size-4 text-primary" />
                  ) : (
                    <XCircle className="size-4 text-red-500" />
                  )}

                  <AlertTitle className="text-foreground mb-0">
                    {connectionStatus ===
                    'connected'
                      ? t(
                          'credentialsValid',
                        )
                      : t(
                          'notConnected',
                        )}
                  </AlertTitle>
                </div>

                <AlertDescription className="text-muted-foreground">
                  {connectionStatus ===
                  'connected'
                    ? t(
                        'connectedDesc',
                      )
                    : statusMessage ||
                      t(
                        'notConnectedDesc',
                      )}
                </AlertDescription>
              </Alert>

              <Alert
                className={
                  isRegistered
                    ? 'bg-emerald-950/30 border-emerald-700/50'
                    : 'bg-amber-950/30 border-amber-700/50'
                }
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    {isRegistered ? (
                      <CheckCircle2 className="size-4 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="size-4 text-amber-400" />
                    )}

                    <AlertTitle
                      className={
                        'mb-0 ' +
                        (isRegistered
                          ? 'text-emerald-200'
                          : 'text-amber-200')
                      }
                    >
                      {isRegistered
                        ? t(
                            'registered',
                          )
                        : t(
                            'notRegistered',
                          )}
                    </AlertTitle>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={
                      handleVerifyRegistration
                    }
                    disabled={
                      verifyingRegistration
                    }
                    className="border-border bg-transparent text-foreground hover:bg-muted h-7"
                  >
                    {verifyingRegistration ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Zap className="size-3.5" />
                    )}

                    {t(
                      'verifyWithMeta',
                    )}
                  </Button>
                </div>

                <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
                  {isRegistered ? (
                    <span
                      dangerouslySetInnerHTML={{
                        __html: t(
                          'subscribedSince',
                          {
                            date:
                              config.registered_at
                                ? new Date(
                                    config.registered_at,
                                  ).toLocaleString()
                                : t(
                                    'unknownDate',
                                  ),
                          },
                        ),
                      }}
                    />
                  ) : lastRegistrationError ? (
                    <>
                      {t(
                        'lastAttemptFailed',
                      )}

                      <span className="text-red-300">
                        &quot;
                        {
                          lastRegistrationError
                        }
                        &quot;
                      </span>

                      .{' '}
                      {t(
                        'retryHint',
                      )}
                    </>
                  ) : (
                    <>
                      {t(
                        'noRegistrationHint',
                      )}
                    </>
                  )}
                </AlertDescription>

                {registrationProbe && (
                  <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                    <p className="font-medium text-foreground">
                      {t(
                        'diagnosticLastRun',
                      )}

                      <span
                        className={
                          registrationProbe.live
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }
                      >
                        {registrationProbe.live
                          ? t('live')
                          : t(
                              'notLive',
                            )}
                      </span>
                    </p>

                    <ul className="space-y-0.5 text-muted-foreground">
                      {Object.entries(
                        registrationProbe.checks,
                      ).map(
                        ([k, v]) => (
                          <li
                            key={k}
                            className="flex items-center gap-1.5"
                          >
                            {v === true ? (
                              <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                            ) : v ===
                              false ? (
                              <XCircle className="size-3 text-red-400 shrink-0" />
                            ) : (
                              <span className="size-3 rounded-full border border-border shrink-0" />
                            )}

                            <code className="text-muted-foreground">
                              {k}
                            </code>
                          </li>
                        ),
                      )}
                    </ul>

                    {(
                      registrationProbe.errors ??
                      []
                    ).length > 0 && (
                      <ul className="pt-1 space-y-0.5 text-red-300">
                        {registrationProbe.errors?.map(
                          (e, i) => (
                            <li key={i}>
                              • {e}
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </Alert>
            </>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {t(
                  'apiCredentialsTitle',
                )}
              </CardTitle>

              <CardDescription className="text-muted-foreground">
                {t(
                  'apiCredentialsDesc',
                )}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t(
                    'phoneNumberId',
                  )}
                </Label>

                <Input
                  placeholder="e.g. 100234567890123"
                  value={
                    phoneNumberId
                  }
                  onChange={(e) =>
                    setPhoneNumberId(
                      e.target.value,
                    )
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('wabaId')}
                </Label>

                <Input
                  placeholder="e.g. 100234567890456"
                  value={wabaId}
                  onChange={(e) =>
                    setWabaId(
                      e.target.value,
                    )
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t(
                    'accessToken',
                  )}
                </Label>

                <div className="relative">
                  <Input
                    type={
                      showToken
                        ? 'text'
                        : 'password'
                    }
                    placeholder={t(
                      'accessTokenPlaceholder',
                    )}
                    value={
                      accessToken
                    }
                    onChange={(e) => {
                      setAccessToken(
                        e.target.value,
                      );
                      setTokenEdited(
                        true,
                      );
                    }}
                    onFocus={() => {
                      if (
                        accessToken ===
                        MASKED_TOKEN
                      ) {
                        setAccessToken(
                          '',
                        );
                        setTokenEdited(
                          true,
                        );
                      }
                    }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                  />

                  <button
                    type="button"
                    onClick={() =>
                      setShowToken(
                        !showToken,
                      )
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showToken ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>

                {config &&
                  !tokenEdited && (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'tokenHidden',
                      )}
                    </p>
                  )}
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t(
                    'webhookVerifyToken',
                  )}
                </Label>

                <Input
                  placeholder={t(
                    'webhookVerifyTokenPlaceholder',
                  )}
                  value={
                    verifyToken
                  }
                  onChange={(e) =>
                    setVerifyToken(
                      e.target.value,
                    )
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />

                <p className="text-xs text-muted-foreground">
                  {t(
                    'webhookVerifyTokenHint',
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t(
                    'twoStepPin',
                  )}

                  <span className="ml-1 text-muted-foreground">
                    {t(
                      'optional',
                    )}
                  </span>
                </Label>

                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t(
                    'pinPlaceholder',
                  )}
                  value={pin}
                  onChange={(e) =>
                    setPin(
                      e.target.value
                        .replace(
                          /\D/g,
                          '',
                        )
                        .slice(
                          0,
                          6,
                        ),
                    )
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
                />

                <p className="text-xs text-muted-foreground leading-relaxed">
                  <span
                    dangerouslySetInnerHTML={{
                      __html: t(
                        'pinHint',
                      ),
                    }}
                  />
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {t(
                  'webhookTitle',
                )}
              </CardTitle>

              <CardDescription className="text-muted-foreground">
                {t(
                  'webhookDesc',
                )}
              </CardDescription>
            </CardHeader>

            <CardContent>
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t(
                    'webhookUrl',
                  )}
                </Label>

                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={
                      webhookUrl
                    }
                    className="bg-muted border-border text-muted-foreground font-mono text-sm"
                  />

                  <Button
                    variant="outline"
                    size="icon"
                    onClick={
                      handleCopyWebhookUrl
                    }
                    className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {config && (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">
                  {t(
                    'mediaTitle',
                  )}
                </CardTitle>

                <CardDescription className="text-muted-foreground">
                  {t(
                    'mediaDesc',
                  )}
                </CardDescription>
              </CardHeader>

              <CardContent>
                <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {t(
                        'mirrorInbound',
                      )}
                    </p>

                    <p className="text-xs text-muted-foreground">
                      {t(
                        'mirrorInboundDesc',
                      )}
                    </p>

                    {!mirrorMedia && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                        {t(
                          'mirrorInboundOffWarning',
                        )}
                      </p>
                    )}
                  </div>

                  <Switch
                    checked={
                      mirrorMedia
                    }
                    onCheckedChange={
                      handleToggleMirrorMedia
                    }
                    disabled={
                      savingMirror ||
                      !canEditSettings
                    }
                    aria-label={t(
                      'mirrorInbound',
                    )}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={
                handleSave
              }
              disabled={
                saving ||
                !canEditSettings
              }
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('saveConfig')
              )}
            </Button>

            <Button
              variant="outline"
              onClick={
                handleTestConnection
              }
              disabled={
                testing ||
                !config
              }
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {testing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('testing')}
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  {t(
                    'testConnection',
                  )}
                </>
              )}
            </Button>

            {config && (
              <Button
                variant="outline"
                onClick={
                  handleReset
                }
                disabled={
                  resetting ||
                  !canEditSettings
                }
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {resetting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t(
                      'resetting',
                    )}
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    {t(
                      'resetConfig',
                    )}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">
                {t(
                  'setupInstructions',
                )}
              </CardTitle>

              <CardDescription className="text-muted-foreground">
                {t(
                  'setupInstructionsDesc',
                )}
              </CardDescription>
            </CardHeader>

            <CardContent>
              <Accordion>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        1
                      </span>

                      {t('step1')}
                    </span>
                  </AccordionTrigger>

                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-1 text-sm">
                      <li
                        dangerouslySetInnerHTML={{
                          __html: t(
                            'step1_1',
                          ),
                        }}
                      />
                      <li>
                        {t(
                          'step1_2',
                        )}
                      </li>
                      <li>
                        {t(
                          'step1_3',
                        )}
                      </li>
                      <li>
                        {t(
                          'step1_4',
                        )}
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        2
                      </span>

                      {t('step2')}
                    </span>
                  </AccordionTrigger>

                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-1 text-sm">
                      <li>
                        {t(
                          'step2_1',
                        )}
                      </li>
                      <li>
                        {t(
                          'step2_2',
                        )}
                      </li>
                      <li>
                        {t(
                          'step2_3',
                        )}
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        3
                      </span>

                      {t('step3')}
                    </span>
                  </AccordionTrigger>

                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-1 text-sm">
                      <li>
                        {t(
                          'step3_1',
                        )}
                      </li>

                      <li
                        dangerouslySetInnerHTML={{
                          __html:
                            t.raw(
                              'step3_2',
                            ),
                        }}
                      />

                      <li
                        dangerouslySetInnerHTML={{
                          __html:
                            t.raw(
                              'step3_3',
                            ),
                        }}
                      />

                      <li
                        dangerouslySetInnerHTML={{
                          __html:
                            t.raw(
                              'step3_4',
                            ),
                        }}
                      />
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        4
                      </span>

                      {t('step4')}
                    </span>
                  </AccordionTrigger>

                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-1 text-sm">
                      <li>
                        {t(
                          'step4_1',
                        )}
                      </li>

                      <li>
                        {t(
                          'step4_2',
                        )}
                      </li>

                      <li
                        dangerouslySetInnerHTML={{
                          __html:
                            t.raw(
                              'step4_3',
                            ),
                        }}
                      />

                      <li
                        dangerouslySetInnerHTML={{
                          __html:
                            t.raw(
                              'step4_4',
                            ),
                        }}
                      />

                      <li>
                        {t(
                          'step4_5',
                        )}
                      </li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <div className="mt-4 pt-4 border-t border-border">
                <a
                  href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  <ExternalLink className="size-3.5" />
                  {t('metaDocs')}
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}