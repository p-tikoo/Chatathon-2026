/**
 * PLACEHOLDER LANDING PAGE — backend branch only.
 *
 * This is an API index so you can see the backend is alive without reaching for
 * curl. It is owned by feat/polish and should be replaced wholesale by the real
 * landing page. Deliberately zero dependencies and zero styling beyond inline
 * styles, so it never conflicts with whatever design system lands later.
 */

const ENDPOINTS = [
  ["GET", "/api/health", "Runtime config: store, LLM provider, whether keys are present"],
  [
    "GET/POST",
    "/api/schedule/organize",
    "★ AI organizing engine — sorts the whole board by complexity, cognitive load, or demand-vs-capacity risk",
  ],
  ["GET", "/api/roster", "Director heatmap — whole department as risk tiers over 24-48h"],
  ["GET", "/api/surgeons", "Directory, redacted per viewer"],
  ["POST", "/api/surgeons", "Register a surgeon with per-field privacy settings"],
  ["GET/PATCH", "/api/surgeons/{id}", "Profile; self-only edits"],
  ["GET/POST", "/api/sleep", "Sleep logging (self-only access)"],
  ["GET/POST", "/api/fatigue", "Alertness score + 48h projection; POST runs the LLM narrative"],
  ["GET/POST", "/api/cases", "Case database; POST auto-resolves CPT/RVU complexity"],
  ["GET/PATCH", "/api/cases/{id}", "Case detail; PATCH submits the 1-10 exertion rating"],
  ["GET/POST", "/api/events", "Non-clinical commitments; personal ones stay private"],
  ["GET", "/api/calendar", "Shared calendar — shifts + cases + events, privacy-filtered"],
  ["GET", "/api/procedures", "CPT / RVU reference catalog"],
  ["POST", "/api/procedures/classify", "LLM: free-text procedure -> CPT, RVU, complexity tier"],
  ["GET/POST", "/api/assign", "AI assignment recommendation (creates a PENDING suggestion)"],
  ["POST", "/api/assign/{id}", "Human approve / override / reject — the only reassignment path"],
  ["GET", "/api/audit", "Accountability trail"],
];

export default function Home() {
  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: "2rem", maxWidth: 900, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: 0 }}>
        Fatigue-aware surgical scheduling — API
      </h1>
      <p style={{ color: "#666", marginTop: ".25rem" }}>
        Backend is running. This page is a placeholder for the frontend branches.
      </p>

      <p
        style={{
          background: "#fff8e1",
          border: "1px solid #ffe082",
          padding: ".75rem 1rem",
          borderRadius: 6,
        }}
      >
        <strong>All data is synthetic.</strong> No real surgeon, patient, or hospital is
        represented, and the system stores no patient data of any kind. Fatigue scoring is
        scheduling decision support — not a medical device, and it does not diagnose.
      </p>

      <p>
        Start with <a href="/api/health">/api/health</a> to see which store and LLM provider are
        active.
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: ".85rem" }}>
        <tbody>
          {ENDPOINTS.map(([method, path, description]) => (
            <tr key={path} style={{ borderTop: "1px solid #eee" }}>
              <td style={{ padding: ".4rem .6rem .4rem 0", color: "#0070f3", whiteSpace: "nowrap" }}>
                {method}
              </td>
              <td style={{ padding: ".4rem .6rem .4rem 0", whiteSpace: "nowrap" }}>{path}</td>
              <td style={{ padding: ".4rem 0", color: "#555" }}>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: "1.5rem", color: "#666", fontSize: ".85rem" }}>
        Most endpoints read the <code>x-viewer-id</code> and <code>x-viewer-role</code> headers to
        decide what you may see. Roles: <code>self</code>, <code>colleague</code>,{" "}
        <code>director</code>, <code>admin</code>, <code>public</code>. This is demo-only identity
        and is trivially spoofable — see <code>lib/http.js</code>.
      </p>
    </main>
  );
}
