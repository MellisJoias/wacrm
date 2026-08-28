"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  MessageSquare,
  Zap,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");

  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);

  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const loadQuickReplies = async () => {
    setLoading(true);

    try {
      const res = await fetch("/api/quick-replies", {
        cache: "no-store",
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(
          data.error ?? "Não foi possível carregar as respostas rápidas."
        );
        return;
      }

      setItems((data.quick_replies as QuickReply[]) ?? []);
    } catch {
      toast.error(
        "Não foi possível carregar as respostas rápidas."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;

    setSearch("");
    void loadQuickReplies();
  }, [open]);

  const handleCreate = async () => {
    const cleanTitle = title.trim();
    const cleanContent = content.trim();

    if (!cleanTitle) {
      toast.error("Digite um nome para a resposta rápida.");
      return;
    }

    if (!cleanContent) {
      toast.error("Digite a mensagem da resposta rápida.");
      return;
    }

    setSaving(true);

    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: cleanTitle,
          kind: "text",
          content_text: cleanContent,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(
          data.error ?? "Não foi possível salvar a resposta rápida."
        );
        return;
      }

      const created = data.quick_reply as QuickReply | undefined;

      if (created) {
        setItems((prev) => [created, ...prev]);
      } else {
        await loadQuickReplies();
      }

      setTitle("");
      setContent("");
      setCreateOpen(false);

      toast.success("Resposta rápida criada.");

    } catch {
      toast.error(
        "Não foi possível salvar a resposta rápida."
      );
    } finally {
      setSaving(false);
    }
  };

  const filteredItems = items.filter((qr) => {
    const q = search.trim().toLowerCase();

    if (!q) return true;

    const titleText = qr.title?.toLowerCase() ?? "";
    const contentText = qr.content_text?.toLowerCase() ?? "";

    return (
      titleText.includes(q) ||
      contentText.includes(q)
    );
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("quickReplies")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

              <Input
                value={search}
                onChange={(e) =>
                  setSearch(e.target.value)
                }
                placeholder="Pesquisar resposta rápida..."
                className="pl-9"
              />
            </div>

            {/* New quick reply */}
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={() =>
                setCreateOpen(true)
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Nova resposta rápida
            </Button>

            <div className="max-h-[50vh] overflow-y-auto">
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="py-8 text-center">
                  <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />

                  <p className="text-sm text-muted-foreground">
                    {search.trim()
                      ? "Nenhuma resposta encontrada."
                      : t("quickRepliesEmpty")}
                  </p>
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {filteredItems.map((qr) => (
                    <li key={qr.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick(qr);
                          onOpenChange(false);
                        }}
                        className="flex w-full items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted"
                      >
                        {qr.kind === "interactive" ? (
                          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        ) : (
                          <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        )}

                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {qr.title}
                          </span>

                          <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs text-muted-foreground">
                            {qr.kind === "interactive" &&
                            qr.interactive_payload
                              ? interactivePayloadPreviewText(
                                  qr.interactive_payload
                                )
                              : qr.content_text}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create text quick reply */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Nova resposta rápida
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Nome
              </label>

              <Input
                value={title}
                onChange={(e) =>
                  setTitle(e.target.value)
                }
                placeholder="Ex.: Apresentação do consignado"
                disabled={saving}
                autoFocus
              />

              <p className="text-xs text-muted-foreground">
                Esse nome será usado para localizar a
                resposta rapidamente.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Mensagem
              </label>

              <textarea
                value={content}
                onChange={(e) =>
                  setContent(e.target.value)
                }
                placeholder="Digite a mensagem que deseja reutilizar..."
                disabled={saving}
                rows={6}
                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
              />

              <p className="text-xs text-muted-foreground">
                A mensagem será inserida na conversa para
                você revisar antes de enviar.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() =>
                setCreateOpen(false)
              }
            >
              Cancelar
            </Button>

            <Button
              type="button"
              disabled={
                saving ||
                !title.trim() ||
                !content.trim()
              }
              onClick={() =>
                void handleCreate()
              }
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Salvar resposta
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}