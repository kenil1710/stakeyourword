import type { Metadata } from "next";
import { ProfileView } from "@/components/ProfileView";
import { shortAddress } from "@/lib/format";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  return {
    title: shortAddress(address),
    description: "Promises made, promises kept, and what it cost when they were not.",
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return <ProfileView address={address} />;
}
