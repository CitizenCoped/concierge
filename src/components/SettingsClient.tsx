"use client";

import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type PushState = "unsupported" | "denied" | "off" | "on" | "busy";

export default function SettingsClient({
  vapidPublicKey,
}: {
  vapidPublicKey: string;
}) {
  const [push, setPush] = useState<PushState>("busy");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPush("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        setPush("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setPush(sub ? "on" : "off");
    })().catch(() => setPush("unsupported"));
  }, []);

  async function enable() {
    setPush("busy");
    setNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPush("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
      setPush("on");
      setNote("Notifications enabled on this device.");
    } catch (e) {
      console.error(e);
      setPush("off");
      setNote("Couldn't enable notifications — try again.");
    }
  }

  async function sendTest() {
    setNote(null);
    const res = await fetch("/api/push/test", { method: "POST" });
    setNote(
      res.ok
        ? "Test sent — check your notifications (Pushover + this device)."
        : "Test failed — check server logs."
    );
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const card =
    "rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900";
  const btn =
    "rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <h2 className="font-semibold">Notifications on this device</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {push === "unsupported" &&
            "This browser doesn't support Web Push. On iPhone, add the app to your Home Screen first."}
          {push === "denied" &&
            "Notifications are blocked — enable them for this app in system settings."}
          {push === "off" && "Get a push here for every front-desk event."}
          {push === "on" && "Enabled — this device receives concierge events."}
          {push === "busy" && "Checking…"}
        </p>
        <div className="mt-3 flex gap-2">
          {(push === "off" || push === "busy") && (
            <button onClick={enable} disabled={push === "busy"} className={btn}>
              Enable notifications
            </button>
          )}
          {push === "on" && (
            <button onClick={sendTest} className={btn}>
              Send test notification
            </button>
          )}
        </div>
        {note && (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
            {note}
          </p>
        )}
      </section>

      <section className={card}>
        <h2 className="font-semibold">Session</h2>
        <button
          onClick={logout}
          className="mt-3 rounded-xl bg-neutral-200 px-4 py-2.5 font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
        >
          Log out
        </button>
      </section>
    </div>
  );
}
