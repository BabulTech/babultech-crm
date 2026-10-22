import { DetailSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <DetailSkeleton />
    </div>
  );
}
