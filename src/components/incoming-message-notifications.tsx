"use client";

import { useEffect, useRef } from "react";

const DEFAULT_TITLE = "wacrm";

export function IncomingMessageNotifications() {
  const unreadRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    /*
     * Desbloqueia o áudio depois da primeira interação do usuário.
     * Navegadores modernos bloqueiam áudio automático até existir
     * alguma interação com a página.
     */
    const unlockAudio = () => {
      try {
        const AudioContextClass =
          window.AudioContext ||
          (
            window as typeof window & {
              webkitAudioContext?: typeof AudioContext;
            }
          ).webkitAudioContext;

        if (!AudioContextClass) {
          return;
        }

        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContextClass();
        }

        if (audioContextRef.current.state === "suspended") {
          audioContextRef.current.resume().catch(() => {});
        }
      } catch {
        // Áudio é opcional; falhas não devem afetar o Inbox.
      }
    };

    window.addEventListener("pointerdown", unlockAudio, {
      passive: true,
    });

    window.addEventListener("keydown", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  useEffect(() => {
    const requestPermissionAfterInteraction = () => {
      if (
        typeof Notification === "undefined" ||
        Notification.permission !== "default"
      ) {
        return;
      }

      Notification.requestPermission().catch(() => {});
    };

    window.addEventListener(
      "pointerdown",
      requestPermissionAfterInteraction,
      {
        passive: true,
      }
    );

    return () => {
      window.removeEventListener(
        "pointerdown",
        requestPermissionAfterInteraction
      );
    };
  }, []);

  useEffect(() => {
    const playNotificationSound = () => {
      try {
        const AudioContextClass =
          window.AudioContext ||
          (
            window as typeof window & {
              webkitAudioContext?: typeof AudioContext;
            }
          ).webkitAudioContext;

        if (!AudioContextClass) {
          return;
        }

        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContextClass();
        }

        const audioContext = audioContextRef.current;

        if (audioContext.state === "suspended") {
          audioContext.resume().catch(() => {});
        }

        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = "sine";

        oscillator.frequency.setValueAtTime(
          880,
          audioContext.currentTime
        );

        oscillator.frequency.setValueAtTime(
          1174.66,
          audioContext.currentTime + 0.08
        );

        gain.gain.setValueAtTime(
          0.0001,
          audioContext.currentTime
        );

        gain.gain.exponentialRampToValueAtTime(
          0.12,
          audioContext.currentTime + 0.015
        );

        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          audioContext.currentTime + 0.18
        );

        oscillator.connect(gain);
        gain.connect(audioContext.destination);

        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.2);
      } catch {
        // Não interrompe o Inbox caso o navegador bloqueie áudio.
      }
    };

    const getMessagePreview = (message: unknown) => {
      const msg = message as {
        content_text?: string | null;
        content?: string | null;
        message_type?: string | null;
        type?: string | null;
      };

      const text =
        msg.content_text ??
        msg.content ??
        "";

      if (text.trim()) {
        return text.trim().slice(0, 120);
      }

      const type =
        msg.message_type ??
        msg.type ??
        "";

      if (type === "image") {
        return "📷 Foto";
      }

      if (type === "video") {
        return "🎥 Vídeo";
      }

      if (type === "audio") {
        return "🎵 Áudio";
      }

      if (type === "document") {
        return "📄 Documento";
      }

      return "Nova mensagem";
    };

    const handleIncomingMessage = (event: Event) => {
      const customEvent =
        event as CustomEvent<Record<string, unknown>>;

      const message = customEvent.detail;

      if (!message) {
        return;
      }

      /*
       * Se o usuário está olhando a aba do WACRM, ainda atualizamos
       * o contador interno da aba, mas não criamos uma notificação
       * nativa sobre a própria tela.
       *
       * O som continua funcionando quando o navegador permitir.
       */
      const isWindowVisible =
        document.visibilityState === "visible";

      /*
       * A mensagem que acabou de chegar pode ser uma mensagem enviada
       * pelo próprio atendente. Como o INSERT chega pelo mesmo canal,
       * evitamos notificação quando o WACRM está em primeiro plano.
       *
       * Quando estiver em outra aba/minimizado, a notificação é exibida.
       */
      if (!isWindowVisible) {
        unreadRef.current += 1;

        document.title =
          unreadRef.current === 1
            ? "🔴 Nova mensagem — wacrm"
            : `🔴 (${unreadRef.current}) Novas mensagens — wacrm`;

        playNotificationSound();

        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          const preview = getMessagePreview(message);

          const notification =
            new Notification("Nova mensagem", {
              body: preview,
              icon: "/icon",
              tag: "wacrm-incoming-message",
            });

          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }

        return;
      }

      /*
       * Se o WACRM está aberto e visível, toca apenas o som.
       * A lista de conversas já será atualizada pelo Inbox.
       */
      playNotificationSound();
    };

    window.addEventListener(
      "wacrm:incoming-message",
      handleIncomingMessage
    );

    const clearTitle = () => {
      unreadRef.current = 0;
      document.title = DEFAULT_TITLE;
    };

    window.addEventListener("focus", clearTitle);

    return () => {
      window.removeEventListener(
        "wacrm:incoming-message",
        handleIncomingMessage
      );

      window.removeEventListener("focus", clearTitle);
    };
  }, []);

  return null;
}