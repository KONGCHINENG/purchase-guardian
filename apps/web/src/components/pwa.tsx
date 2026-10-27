"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { Alert, Button, Card } from "./ui";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** Registers the service worker once per page load. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);
  return null;
}

const urlBase64ToUint8Array = (base64: string) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

type PushState = "unsupported" | "disabled-server" | "denied" | "off" | "on" | "loading";

/** "Phone mode" card: install the app and turn on approval notifications. */
export function DeviceCard() {
  const [push, setPush] = useState<PushState>("loading");
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setPush("unsupported");
    const config = await api<{ enabled: boolean; publicKey: string | null }>("/push/config").catch(() => null);
    if (!config?.enabled) return setPush("disabled-server");
    if (Notification.permission === "denied") return setPush("denied");
    const reg = await navigator.serviceWorker.getRegistration();
    setPush((await reg?.pushManager.getSubscription()) ? "on" : "off");
  }, []);

  useEffect(() => {
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
    setIsIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    void refresh();
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await api<{ publicKey: string | null }>("/push/config");
      if (!config.publicKey) throw new Error("Notifications aren't configured on the server");
      if ((await Notification.requestPermission()) !== "granted") return setPush("denied");
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
      await api("/push/subscriptions", { method: "POST", body: sub.toJSON() });
      await api("/push/test", { method: "POST" });
      setPush("on");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      if (sub) {
        await api("/push/subscriptions", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setPush("off");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 text-sm">
      <p className="font-medium text-ink">📱 Approve from your phone</p>
      <p className="mt-1 text-ink-soft">Install Guardian and get a notification whenever a purchase needs you.</p>

      {!standalone && (
        <div className="mt-3">
          {installEvent ? (
            <Button
              variant="secondary"
              className="w-full"
              onClick={async () => {
                await installEvent.prompt();
                setInstallEvent(null);
              }}
            >
              Install app
            </Button>
          ) : isIos ? (
            <p className="rounded-[10px] bg-sunken px-3 py-2 text-xs text-ink-soft">
              On iPhone: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>, then open Guardian from your home screen to turn on notifications.
            </p>
          ) : (
            <p className="text-xs text-ink-faint">Open this page on your phone to install it (browser menu → Install app / Add to Home screen).</p>
          )}
        </div>
      )}

      <div className="mt-3">
        {push === "on" && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-brand">✓ Notifications on</span>
            <Button variant="ghost" onClick={disable} loading={busy}>
              Turn off
            </Button>
          </div>
        )}
        {push === "off" && (
          <Button className="w-full" onClick={enable} loading={busy}>
            Turn on approval notifications
          </Button>
        )}
        {push === "denied" && <p className="text-xs text-warn">Notifications are blocked in this browser's settings.</p>}
        {push === "disabled-server" && <p className="text-xs text-ink-faint">Push isn't configured on this server (VAPID keys missing).</p>}
        {push === "unsupported" && <p className="text-xs text-ink-faint">This browser doesn't support push.{isIos ? " Add Guardian to your home screen first." : ""}</p>}
      </div>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
    </Card>
  );
}
