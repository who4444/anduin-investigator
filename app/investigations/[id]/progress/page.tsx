import { ProgressView } from "@/app/_components/progress-view";

export const dynamic = "force-dynamic";

export default async function ProgressPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  return (
    <ProgressView
      investigationId={id}
      flags={{
        synthetic: query.synthetic === "1",
        cached: query.cached === "1",
        live: query.live === "1",
      }}
      reviewOnly={query.review === "1"}
      rerun={query.rerun === "1"}
    />
  );
}
