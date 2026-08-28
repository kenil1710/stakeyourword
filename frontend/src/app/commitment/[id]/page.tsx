import type { Metadata } from "next";
import { CommitmentView } from "@/components/CommitmentView";

/**
 * `params` is a Promise in Next 16 — this stays a server component purely to
 * await it and hand a plain number to the client tree below.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Commitment #${id}`,
    description: "A promise, its stake, and every verdict the network has reached on it.",
  };
}

export default async function CommitmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Number(id);
  return <CommitmentView id={Number.isInteger(parsed) && parsed >= 0 ? parsed : null} />;
}
