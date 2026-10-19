export default function Loading() {
  return (
    <div className="shell shell-sm stack" aria-busy="true" aria-label="Loading the investigation">
      <div className="skeleton skeleton-line" style={{ width: "46%", height: 26 }} />
      <div className="panel stack">
        {[0, 1, 2, 3].map((index) => (
          <div className="row" key={index} style={{ gap: "var(--sp-4)" }}>
            <div className="skeleton" style={{ width: 32, height: 32, borderRadius: "50%" }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton skeleton-line" style={{ width: `${60 - index * 8}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
