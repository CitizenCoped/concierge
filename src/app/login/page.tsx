"use client";

import { useState } from "react";

export default function LoginPage() {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    if (res.ok) {
      window.location.href = "/";
    } else {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <div className="text-5xl">🔔</div>
        <h1 className="mt-2 text-2xl font-bold">Angel Concierge</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Scott &amp; Monica&apos;s front desk assistant
        </p>
      </div>
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
        <input
          type="password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Passphrase"
          className="rounded-xl border border-neutral-300 bg-white px-4 py-3 text-base outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={busy || !passphrase}
          className="rounded-xl bg-blue-600 px-4 py-3 font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Checking…" : "Enter"}
        </button>
        {error && (
          <p className="text-center text-sm text-red-600">
            That passphrase isn&apos;t right.
          </p>
        )}
      </form>
    </main>
  );
}
