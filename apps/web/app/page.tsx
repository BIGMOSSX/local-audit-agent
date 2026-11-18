import { Button } from "@audit/ui";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Local Audit Agent</h1>
      <p>Website shell. Content lands in the website plan.</p>
      <Button variant="primary">Shell button</Button>
    </main>
  );
}
