/** The sign-in card's shape, shown while the page checks for an existing session. */
export default function Loading() {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-7 shadow-lg">
        <div className="mb-7 flex flex-col items-center gap-2">
          <div className="skeleton h-12 w-12 rounded-xl" />
          <div className="skeleton h-6 w-40 rounded" />
          <div className="skeleton h-4 w-28 rounded opacity-60" />
        </div>
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2">
              <div className="skeleton h-4 w-16 rounded" />
              <div className="skeleton h-9 w-full rounded-md" />
            </div>
          ))}
          <div className="skeleton h-9 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
