// Library — reusable folders of files workers read before they act.
import dynamic from "next/dynamic";

const BrainCollection = dynamic(() => import("@/app/brain/BrainCollection"));

export default function LibraryPage() {
  return <BrainCollection initialFolders={[]} />;
}
