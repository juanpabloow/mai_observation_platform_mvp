import Link from "next/link";

export default async function ExecutionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-12">
      <Link
        href="/executions"
        className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
      >
        &larr; Back to executions
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Execution detail</h1>
      <p className="text-neutral-500">
        Execution{" "}
        <span className="font-mono text-neutral-300">{id}</span>
      </p>
      <div className="rounded-2xl border border-black/10 bg-black/[0.02] p-6 text-sm text-neutral-500 dark:border-white/10 dark:bg-white/[0.03]">
        The detailed execution view (status, timeline, raw payload, mapped
        conversation) is coming in a later step.
      </div>
    </main>
  );
}
