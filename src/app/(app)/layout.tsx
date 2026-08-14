import Nav from "@/components/Nav";

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-lg pb-24">
      {children}
      <Nav />
    </div>
  );
}
