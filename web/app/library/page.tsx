"use client";

// Library — reusable folders of files workers read before they act.
import BrainCollection from "@/app/brain/BrainCollection";

export default function LibraryPage() {
  return <BrainCollection initialFolders={[]} />;
}
