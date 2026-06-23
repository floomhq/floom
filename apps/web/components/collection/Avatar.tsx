// Seeded identity mark for collection items without a brand logo.
// Uses the locked shared generator (chunky 2-tone mark, no letters, no
// rainbow/gradient — SPEC: workeros-design-baseline/SPEC.md). Items are
// non-human entities, so they take the squircle shape.
import { Avatar as IdentityMark } from "@/components/ui/Avatar";

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return <IdentityMark role="workspace" name={name} size={size} />;
}
