/* One-off: refresh the decision fixtures' events with envelope meta by
   re-ingesting the scenario exports through the running app and copying the
   fresh event objects (same content-hash ids) into the fixtures. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.REVIEW_BASE ?? "http://127.0.0.1:3000";

function demoForm(escalation) {
  const manifest = JSON.parse(readFileSync("public/demo/manifest.json", "utf8"));
  const form = new FormData();
  for (const name of manifest.files) {
    form.append("files", new File([new Uint8Array(readFileSync(`public/demo/${name}`))], name, {
      type: name.endsWith(".json") ? "application/json" : "application/octet-stream",
    }));
  }
  form.append("escalation", escalation);
  form.append("origin", "demo");
  form.append("title", "Fixture meta refresh");
  return form;
}

async function main() {
  const escalation = "Fixture meta refresh run for regression data.";
  const res = await fetch(`${BASE}/api/investigations`, {
    method: "POST",
    body: demoForm(escalation),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text()}`);
  const { investigationId } = await res.json();
  console.log("fresh investigation:", investigationId);

  const report = await (await fetch(`${BASE}/api/investigations/${investigationId}/report`)).json();
  const freshById = new Map((report.events ?? []).map((event) => [event.id, event]));

  const fixturePath = path.resolve("tests/fixtures/decision/demo.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  let patched = 0;
  const events = fixture.events.map((event) => {
    const fresh = freshById.get(event.id);
    if (fresh && JSON.stringify(fresh.meta ?? {}) !== JSON.stringify(event.meta ?? {})) {
      patched += 1;
      return { ...event, meta: fresh.meta, actorResolved: fresh.actorResolved ?? event.actorResolved };
    }
    return event;
  });
  fixture.events = events;
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`patched ${patched} events with envelope meta`);

  await fetch(`${BASE}/api/investigations/${investigationId}`, { method: "DELETE" }).catch(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
