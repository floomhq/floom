"use client";

// Brain — migrated to the <Collection> model (SPEC §5). Folders are the items;
// clicking a folder opens a split with Files + Used-by.
import BrainCollection from "./BrainCollection";

export default function BrainPage() {
  return <BrainCollection initialFolders={[]} />;
}
