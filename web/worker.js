// Сторінка «Напруга зараз»: живий знімок плати з GitHub (змінна SENSOR) + історія в D1.
// Безкоштовний план: GitHub читаємо не частіше разу на 10 с (кеш), D1 - одна точка на хвилину, історія збирається раз на 5 хв.
import PAGE from "./page.html"

const GH = "https://api.github.com/repos/NoireLab-dev/svitlo-bot/actions/variables/SENSOR"

async function sensor(env) {
  const r = await fetch(GH, { headers: { authorization: `Bearer ${env.GH_TOKEN}`, "user-agent": "svitlo-web", accept: "application/vnd.github+json" } })
  if (!r.ok) throw new Error(`github ${r.status}`)
  return JSON.parse((await r.json()).value)
}

const json = (d, sec) => new Response(JSON.stringify(d), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${sec}` } })

// відповідь із кешу Cloudflare, інакше рахуємо й кладемо на sec секунд
async function cached(req, ctx, sec, make) {
  const cache = caches.default, key = new Request(new URL(req.url).origin + new URL(req.url).pathname)
  const hit = await cache.match(key)
  if (hit) return hit
  const res = json(await make(), sec)
  ctx.waitUntil(cache.put(key, res.clone()))
  return res
}

// знімок для сторінки: лише те, що треба показати
const view = (S) => ({ t: S.t, on: S.on, v: Math.round(S.v), p: (S.p || []).slice(-5), x: (S.x || []).slice(-5) })

async function history(env) {
  const now = Math.floor(Date.now() / 1000)
  const [day, week, ev] = await env.DB.batch([
    env.DB.prepare("SELECT t, v, o FROM s1 WHERE t > ? ORDER BY t").bind(now - 86400),
    env.DB.prepare("SELECT t, lo, hi, o FROM s10 WHERE t > ? ORDER BY t").bind(now - 7 * 86400),
    env.DB.prepare("SELECT k, s, e, pk FROM e WHERE s > ? ORDER BY s DESC LIMIT 60").bind(now - 7 * 86400),
  ])
  return { at: now, day: day.results.map((r) => [r.t, r.v, r.o]), week: week.results.map((r) => [r.t, r.lo, r.hi, r.o]), ev: ev.results.map((r) => [r.k, r.s, r.e, r.pk]) }
}

async function tick(env) {
  const S = await sensor(env), now = Math.floor(Date.now() / 1000), m = now - (now % 60)
  const q = []
  if (now - S.t < 300) {
    q.push(env.DB.prepare("INSERT OR REPLACE INTO s1 VALUES (?, ?, ?)").bind(m, Math.round(S.v), S.on ? 1 : 0))
    // події з плати: лише свіжі або ще відкриті, щоб не переписувати старе
    for (const [k, list] of [["p", S.p], ["x", S.x]]) for (const [s, e, pk] of list || [])
      if (!e || now - e < 900) q.push(env.DB.prepare("INSERT INTO e VALUES (?, ?, ?, ?) ON CONFLICT(k, s) DO UPDATE SET e = excluded.e, pk = excluded.pk").bind(k, s, e, pk))
  }
  if (m % 600 === 0) {
    q.push(env.DB.prepare("INSERT OR REPLACE INTO s10 SELECT ?, MIN(v), MAX(v), MIN(o) FROM s1 WHERE t >= ? AND t < ? HAVING COUNT(*) > 0").bind(m - 600, m - 600, m))
    q.push(env.DB.prepare("DELETE FROM s1 WHERE t < ?").bind(now - 90000))
  }
  if (m % 3600 === 0) q.push(env.DB.prepare("DELETE FROM s10 WHERE t < ?").bind(now - 8 * 86400), env.DB.prepare("DELETE FROM e WHERE s < ?").bind(now - 8 * 86400))
  if (q.length) await env.DB.batch(q)
  if (m % 300 === 0) await env.DB.prepare("INSERT OR REPLACE INTO c VALUES (1, ?)").bind(JSON.stringify(await history(env))).run()
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url)
    if (pathname === "/api/now") return cached(req, ctx, 10, async () => ({ ...view(await sensor(env)), now: Math.floor(Date.now() / 1000) }))
    if (pathname === "/api/hist") return cached(req, ctx, 60, async () => {
      const row = await env.DB.prepare("SELECT j FROM c WHERE id = 1").first()
      return row ? JSON.parse(row.j) : await history(env)
    })
    if (pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } })
    return new Response("Not found", { status: 404 })
  },
  async scheduled(_, env, ctx) { ctx.waitUntil(tick(env)) },
}
