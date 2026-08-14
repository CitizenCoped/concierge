import SettingsClient from "@/components/SettingsClient";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">⚙️ Settings</h1>
      </header>
      <SettingsClient vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? ""} />
    </main>
  );
}
