import Link from "next/link";
import { shortAddress } from "@/lib/format";

/** An address, shortened, linking to its profile. `you` when it is the viewer. */
export function AddressLink({
  address,
  you = false,
  className = "",
}: {
  address: string;
  you?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={`/profile/${address}`}
      className={`mono link-quiet text-[12.5px] ${className}`}
      title={address}
    >
      {you ? "you" : shortAddress(address)}
    </Link>
  );
}
