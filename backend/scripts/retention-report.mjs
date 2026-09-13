// Retention report built from public.activity_days. Prints aggregates only —
// no user ids, emails or content.
//
//   node backend/scripts/retention-report.mjs          all rows
//   node backend/scripts/retention-report.mjs --live   ignore backfilled history
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from backend/.env.
import fs from "fs";

const env = {};
for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
const { SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: KEY } = env;
if (!BASE || !KEY) {
  console.error("backend/.env needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const LIVE_ONLY = process.argv.includes("--live");

// New sb_secret_ keys go in the apikey header only; legacy JWT keys also need
// the Authorization header.
async function get(path) {
  const attempts = KEY.startsWith("sb_")
    ? [{ apikey: KEY }, { apikey: KEY, Authorization: `Bearer ${KEY}` }]
    : [{ apikey: KEY, Authorization: `Bearer ${KEY}` }];
  let res;
  for (const headers of attempts) {
    // Supabase's gateway occasionally answers 502/503/504; retry those briefly.
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      res = await fetch(BASE + path, { headers });
      if (![502, 503, 504].includes(res.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * tryNo));
    }
    if (res.status !== 401) break;
  }
  if (!res.ok) {
    const body = await res.text();
    if (/activity_days/.test(body) && /(PGRST205|42P01|does not exist|Could not find the table)/.test(body)) {
      console.error("activity_days doesn't exist yet — run backend/11-activity-days-setup.sql in Supabase first.");
      process.exit(1);
    }
    throw new Error(`${path.split("?")[0]} → HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

const DAY_MS = 86400000;
const toDate = d => new Date(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(toDate(d).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const diffDays = (from, to) => Math.round((toDate(to) - toDate(from)) / DAY_MS);
const mondayOf = d => addDays(d, -((toDate(d).getUTCDay() + 6) % 7));
const today = new Date().toISOString().slice(0, 10);

// ── load ─────────────────────────────────────────────────────────
const users = [];
for (let page = 1; ; page++) {
  const { users: batch = [] } = await get(`/auth/v1/admin/users?page=${page}&per_page=1000`);
  users.push(...batch);
  if (batch.length < 1000) break;
}
const rows = [];
for (let offset = 0; ; offset += 1000) {
  const batch = await get(`/rest/v1/activity_days?select=user_id,day,backfilled&order=day&limit=1000&offset=${offset}`);
  rows.push(...batch);
  if (batch.length < 1000) break;
}
const used = LIVE_ONLY ? rows.filter(r => !r.backfilled) : rows;

const daysByUser = new Map();
for (const r of used) {
  if (!daysByUser.has(r.user_id)) daysByUser.set(r.user_id, new Set());
  daysByUser.get(r.user_id).add(r.day);
}

// Day 0 is the first active day when it falls within a day of the UTC signup
// date. Activity days are the user's local day, so without this a late-night
// signup in Moscow would look like a "came back on day 1".
const people = users.map(u => {
  const signup = (u.created_at || "").slice(0, 10);
  const days = daysByUser.get(u.id) || new Set();
  const first = [...days].sort()[0];
  const anchor = first && Math.abs(diffDays(signup, first)) <= 1 ? first : signup;
  return { anchor, days };
});

// ── report ───────────────────────────────────────────────────────
const pct = (n, of) => (of ? `${String(Math.round((100 * n) / of)).padStart(3)}% (${n}/${of})` : "—");
const head = t => console.log(`\n━━ ${t} ${"━".repeat(Math.max(0, 62 - t.length))}`);

console.log(`Retention report · ${today}${LIVE_ONLY ? " · live rows only" : ""}`);
console.log(`activity rows: ${used.length} (${rows.filter(r => r.backfilled).length} backfilled of ${rows.length} total) · users with activity: ${daysByUser.size} of ${users.length}`);

// Each window is [label, first day, last day] counted from day 0.
const WINDOWS = [["day 0", 0, 0], ["day 1", 1, 1], ["days 2–7", 2, 7], ["week 2", 7, 13], ["week 5", 28, 34]];
const activeIn = (p, from, to) => [...p.days].some(d => {
  const n = diffDays(p.anchor, d);
  return n >= from && n <= to;
});
// Only people who have lived through the whole window count toward it.
const cell = (group, [, from, to]) => {
  const eligible = group.filter(p => diffDays(p.anchor, today) >= to);
  return pct(eligible.filter(p => activeIn(p, from, to)).length, eligible.length);
};

head("COHORTS BY SIGNUP WEEK — share active in each window");
console.log(`  ${"week of".padEnd(11)} ${"users".padStart(5)}  ${WINDOWS.map(([l]) => l.padEnd(15)).join(" ")}`);
const cohorts = new Map();
for (const p of people) {
  const week = mondayOf(p.anchor);
  if (!cohorts.has(week)) cohorts.set(week, []);
  cohorts.get(week).push(p);
}
for (const week of [...cohorts.keys()].sort()) {
  const group = cohorts.get(week);
  console.log(`  ${week.padEnd(11)} ${String(group.length).padStart(5)}  ${WINDOWS.map(w => cell(group, w).padEnd(15)).join(" ")}`);
}
console.log(`  ${"all".padEnd(11)} ${String(people.length).padStart(5)}  ${WINDOWS.map(w => cell(people, w).padEnd(15)).join(" ")}`);

head("LAST 14 DAYS — daily active users");
for (let i = 13; i >= 0; i--) {
  const d = addDays(today, -i);
  const n = people.filter(p => p.days.has(d)).length;
  console.log(`  ${d}  ${String(n).padStart(3)}  ${"█".repeat(n)}`);
}
const weekly = people.filter(p => [...p.days].some(d => diffDays(d, today) >= -1 && diffDays(d, today) <= 6)).length;
console.log(`  active in the last 7 days: ${weekly}`);

head("ACTIVE DAYS PER USER (users with any activity)");
const buckets = { "1": 0, "2–3": 0, "4–7": 0, "8–14": 0, "15+": 0 };
for (const days of daysByUser.values()) {
  const n = days.size;
  buckets[n <= 1 ? "1" : n <= 3 ? "2–3" : n <= 7 ? "4–7" : n <= 14 ? "8–14" : "15+"]++;
}
for (const [label, n] of Object.entries(buckets)) console.log(`  ${label.padEnd(5)} days  ${pct(n, daysByUser.size)}`);

if (!LIVE_ONLY && rows.some(r => r.backfilled)) {
  console.log("\nNote: backfilled history only recovers days older tables happened to keep, so");
  console.log("cohorts from before the migration are a lower bound. Use --live for exact numbers.");
}
