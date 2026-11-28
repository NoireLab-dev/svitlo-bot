// Бот графиків ДТЕК КРЕМ для одного будинку: картинка + живий підпис у закріпі, нагадування за 10 хв.
// Сусіди підписуються на бота (/start). Запуск раз на 5 хв (cron-job.org -> GitHub Actions). Стан у state.bin.
// Збої Telegram і ДТЕК не валять запуск: повтори, а нагадування йдуть з останнього відомого графіка.
import { chromium } from "playwright"
import fs from "node:fs"
import crypto from "node:crypto"
import { sensorPlan, sensorLine, slotFrom, prune, fresh, D } from "./sensor.mjs"

const { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, DRY_RUN, STATE_KEY } = process.env
const CITY = process.env.CITY || "м. Ірпінь"
const STREET = process.env.STREET || "вул. Джерельна"
const GROUP = process.env.GROUP || "6.2"
const TITLE = process.env.TITLE || "Джерельна 10"
const CARD_V = 6 // зміна дизайну картки -> тихо надіслати нову всім
const HOUSE = process.env.HOUSE || "10"
const OWNER = process.env.OWNER_CHAT_ID
const STATE_FILE = "state.bin"
// знімок датчика з прошивки (змінна репозиторію SENSOR); у публічні логи не друкуємо
const SENSOR = (() => { try { return JSON.parse(process.env.SENSOR || "null") } catch { return null } })()
// SENSOR_LIVE=1 - пости датчика в канал і рядок у закріпі; інакше тестовий режим: усе лише власнику з позначкою 🧪
const LIVE = process.env.SENSOR_LIVE === "1"
// кнопка під карткою: сторінка з живою напругою (web/, Cloudflare Worker)
const BTN = LIVE ? { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "⚡️ Напруга зараз і графік", url: "https://svitlo.thelightdeal.workers.dev" }]] }) } : {}
const DAYS = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"]

// ---------- дані ----------
async function fetchSchedule(page) {
  try { return await fetchOnce(page) } catch (e) { console.log("ДТЕК, повтор:", e.message); return fetchOnce(page) }
}
async function fetchOnce(page) {
  await page.goto("https://www.dtek-krem.com.ua/ua/shutdowns", { waitUntil: "load", timeout: 90000 })
  const csrf = await (await page.waitForSelector('meta[name="csrf-token"]', { state: "attached", timeout: 60000 })).getAttribute("content")
  return page.evaluate(async ({ csrf, CITY, STREET }) => {
    const f = new URLSearchParams()
    f.append("method", "getHomeNum")
    f.append("data[0][name]", "city"); f.append("data[0][value]", CITY)
    f.append("data[1][name]", "street"); f.append("data[1][value]", STREET)
    f.append("data[2][name]", "updateFact"); f.append("data[2][value]", new Date().toLocaleString("uk-UA"))
    const r = await fetch("/ua/ajax", { method: "POST", headers: { "x-requested-with": "XMLHttpRequest", "x-csrf-token": csrf }, body: f })
    return r.json()
  }, { csrf, CITY, STREET })
}

// 48 півгодинних слотів: "on" | "off" | "maybe"
const HALVES = { yes: ["on", "on"], no: ["off", "off"], first: ["off", "on"], second: ["on", "off"],
  maybe: ["maybe", "maybe"], mfirst: ["maybe", "on"], msecond: ["on", "maybe"] }
export function toSlots(hours) {
  if (!hours) return null
  const s = []
  for (let h = 1; h <= 24; h++) s.push(...(HALVES[hours[h]] || ["on", "on"]))
  return s
}

// інтервали відключень (off і maybe) у хвилинах від початку доби
export function intervals(slots) {
  const out = []
  slots?.forEach((v, i) => {
    if (v === "on") return
    const last = out.at(-1)
    if (last && last.end === i * 30 && last.kind === v) last.end += 30
    else out.push({ start: i * 30, end: i * 30 + 30, kind: v })
  })
  return out
}

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
const dur = (m) => (m % 60 ? `${Math.floor(m / 60)} год ${m % 60} хв` : `${m / 60} год`).replace(/^0 год /, "")
const dayLabel = (date) => `${DAYS[date.getDay()]} ${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`

// ---------- текст ----------
function dayBlock(name, date, slots) {
  if (!slots) return `<b>${name}, ${dayLabel(date)}</b>\n<i>графіка ще немає</i>`
  const iv = intervals(slots)
  if (!iv.length) return `<b>${name}, ${dayLabel(date)}</b>\n🟢 без відключень`
  const off = iv.filter((x) => x.kind === "off").reduce((a, x) => a + x.end - x.start, 0)
  const lines = iv.map((x) => `${x.kind === "off" ? "🔴" : "🟡"} ${hm(x.start)}–${hm(x.end)}${x.kind === "maybe" ? " можливо" : ""}`)
  return `<b>${name}, ${dayLabel(date)}</b>\n${lines.join("\n")}\n<i>без світла ${dur(off)}</i>`
}

// стан «зараз» з урахуванням завтрашнього дня
function nowLine(today, tomorrow, nowMin) {
  const all = [...(today || Array(48).fill("on")), ...(tomorrow || [])]
  const i = Math.floor(nowMin / 30)
  const cur = all[i]
  let j = i
  while (j < all.length && (all[j] === "off") === (cur === "off")) j++
  const at = j >= all.length ? null : hm((j * 30) % 1440) + (j >= 48 ? " завтра" : "")
  if (cur === "off") return `⚫️ <b>Зараз світла немає</b>${at ? ` · увімкнення о ${at}` : ""}`
  return `💡 <b>Зараз світло є</b>${at ? ` · вимкнення о ${at}` : " · відключень не заплановано"}`
}

// ---------- картинка ----------
// суцільні відрізки однакового стану: [{kind, start, end}] у слотах по 30 хв
const runs = (slots) => slots.reduce((o, v, i) => (o.at(-1)?.kind === v ? o.at(-1).end++ : o.push({ kind: v, start: i, end: i + 1 }), o), [])

// без «зараз»: картинка перемальовується лише при зміні графіка, живий стан - у підписі
function cardHtml(rows, updated) {
  const grid = Array.from({ length: 9 }, (_, k) => `<span style="left:${(k / 8) * 100}%">${String(k * 3).padStart(2, "0")}</span>`).join("")
  const row = ({ name, date, slots }) => {
    let bar = `<div class="none">графіка ще немає</div>`
    if (slots) {
      bar = runs(slots).map(({ kind, start, end }) => {
        const n = end - start
        const txt = kind === "on" ? (n >= 5 ? "є світло" : "") : n >= 4 ? `${hm(start * 30)}<br>${hm(end * 30)}` : ""
        return `<div class="seg ${kind}" style="flex:${n}">${txt}</div>`
      }).join("")
    }
    const all = slots ? intervals(slots) : []
    const iv = all.filter((x) => x.kind === "off")
    const list = all.map((x) => `<span class="${x.kind}t">${hm(x.start)}–${hm(x.end)}${x.kind === "maybe" ? " можливо" : ""}</span>`).join("")
    const sum = !slots ? "" : iv.length ? `без світла ${dur(iv.reduce((a, x) => a + x.end - x.start, 0))}` : "без відключень"
    return `<div class="row glass"><div class="lbl"><div>${name}</div><span>${dayLabel(date)}</span><em class="${iv.length ? "red" : ""}">${sum}</em></div>
      <div class="col"><div class="bar">${bar}</div>${slots ? `<div class="axis">${grid}</div>` : ""}${list ? `<div class="list">${list}</div>` : ""}</div></div>`
  }
  return `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box} body{width:1200px;background:#070b18;font:600 26px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif;color:#f2f5ff}
  .card{position:relative;overflow:hidden;padding:44px 48px 40px;background:#070b18}
  .blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.75}
  .b1{width:620px;height:620px;left:-160px;top:-260px;background:#1f5bff} .b2{width:520px;height:520px;right:-120px;bottom:-240px;background:#ffcc00;opacity:.45}
  .b3{width:460px;height:460px;left:420px;top:120px;background:#7b3cff;opacity:.45}
  .in{position:relative}
  .glass{background:linear-gradient(135deg,rgba(255,255,255,.14),rgba(255,255,255,.05));border:1px solid rgba(255,255,255,.22);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 20px 50px rgba(0,0,0,.35);backdrop-filter:blur(26px) saturate(150%)}
  .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px}
  h1{font-size:42px;font-weight:800;letter-spacing:-.5px} .grp{margin-left:14px;padding:6px 16px;border-radius:999px;font-size:22px;vertical-align:7px}
  .upd{padding:10px 18px;border-radius:16px;color:#c9d3ea;font-size:19px;text-align:right;font-weight:500}
  .row{display:flex;align-items:flex-start;gap:26px;padding:24px 26px;border-radius:28px;margin-bottom:20px}
  .lbl{width:170px;padding-top:6px} .lbl div{font-size:30px;font-weight:800} .lbl span{color:#b7c2dc;font-size:22px;font-weight:500}
  .lbl em{display:block;margin-top:8px;font-style:normal;font-size:20px;color:#b7c2dc} .lbl em.red{color:#ffb3b5}
  .col{flex:1}
  .bar{position:relative;height:84px;display:flex;gap:5px}
  .seg{display:flex;align-items:center;justify-content:center;border-radius:14px;font-size:24px;line-height:1.1;font-weight:800;text-align:center;white-space:nowrap;overflow:hidden;border:1px solid rgba(255,255,255,.28)}
  .on{background:linear-gradient(180deg,rgba(70,225,145,.78),rgba(25,165,95,.72));color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 8px 22px rgba(40,200,120,.25)}
  .off{background:linear-gradient(180deg,#ff6b70,#e0313a);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 10px 28px rgba(255,60,70,.55)}
  .maybe{background:repeating-linear-gradient(135deg,rgba(255,190,60,.9) 0 12px,rgba(200,130,20,.75) 12px 24px);color:#1a1200;box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 10px 26px rgba(255,170,40,.4)}
  .none{flex:1;display:flex;align-items:center;justify-content:center;border:2px dashed rgba(255,255,255,.25);border-radius:14px;color:#b7c2dc}
  .axis{position:relative;margin-top:10px;height:24px;color:#aab6d3;font-size:19px;font-weight:500} .axis span{position:absolute;transform:translateX(-50%)}
  .list{display:flex;flex-wrap:wrap;gap:10px 12px;margin-top:12px} .list span{padding:6px 14px;border-radius:12px;font-size:22px;font-weight:700;border:1px solid rgba(255,255,255,.2);backdrop-filter:blur(10px)}
  .offt{background:rgba(255,80,90,.38);color:#ffd0d2} .maybet{background:rgba(255,180,50,.2);color:#ffe0a8}
  .leg{display:flex;gap:30px;margin-top:8px;color:#c9d3ea;font-size:22px} .leg b{display:inline-block;width:24px;height:24px;border-radius:7px;vertical-align:-4px;margin-right:8px;border:1px solid rgba(255,255,255,.3)}
  </style><div class="card"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i><div class="in">
  <div class="head"><h1>⚡ ${TITLE}<span class="grp glass">черга ${GROUP}</span></h1><div class="upd glass">ДТЕК оновив<br>${updated}</div></div>
  ${row(rows[0])}${row(rows[1])}
  <div class="leg"><span><b class="on"></b>світло є</span><span><b class="off"></b>світла немає</span><span><b class="maybe"></b>можливе відключення</span></div>
  </div></div>`
}

// ---------- Telegram ----------
const GONE = /blocked|deactivated|chat not found|user is deactivated/
async function tg(method, params, file) {
  // тиха ніч 23:00-07:00 (TZ Europe/Kyiv): нічого не дзвонить
  const h = new Date().getHours()
  if (/^send/.test(method) && (h >= 23 || h < 7)) params = { ...params, disable_notification: true }
  if (DRY_RUN) { console.log("[dry]", method, params.chat_id ?? "", (params.caption || params.text || "").slice(0, 60)); return { message_id: 1 } }
  let body
  if (file && typeof file !== "string") {
    body = new FormData()
    for (const [k, v] of Object.entries(params)) body.append(k, String(v))
    body.append("photo", new Blob([file], { type: "image/png" }), "grafik.png")
  } else body = new URLSearchParams(Object.entries(file ? { ...params, photo: file } : params).map(([k, v]) => [k, String(v)]))
  let r
  for (let i = 1; ; i++) {
    // мережа, 5xx і 429 у Telegram бувають хвилинами: повторюємо, а не валимо весь запуск
    try { r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(30000) })).json() }
    catch (e) { r = { ok: false, description: `network: ${e.message}` } }
    const retry = !r.ok && (r.error_code >= 500 || r.error_code === 429 || /^network/.test(r.description))
    if (!retry || i === 4) break
    await new Promise((ok) => setTimeout(ok, (r.parameters?.retry_after ?? 2 ** i * 3) * 1000))
  }
  if (!r.ok) console.log(`tg ${method}: ${r.description}`) // текст помилки без chat_id
  if (!r.ok && GONE.test(r.description)) return { gone: true }
  if (!r.ok && /not modified/.test(r.description)) return { same: true }
  if (!r.ok && !/not modified|not found|can't be/.test(r.description)) throw new Error(`${method}: ${r.description}`)
  return r.result
}

// ---------- стан (зашифрований: у ньому chat_id підписників, а репозиторій відкритий) ----------
const KEY = STATE_KEY && crypto.scryptSync(STATE_KEY, "svitlo-bot", 32)
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {}
  const raw = fs.readFileSync(STATE_FILE)
  if (!KEY) return JSON.parse(raw)
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]))
}
function saveState(s) {
  const json = Buffer.from(JSON.stringify(s))
  if (!KEY) return fs.writeFileSync(STATE_FILE, json)
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv)
  const enc = Buffer.concat([c.update(json), c.final()])
  fs.writeFileSync(STATE_FILE, Buffer.concat([iv, c.getAuthTag(), enc]))
}

// надіслати картку одному підписнику, закріпити, а попередню прибрати
async function sendCard(chatId, sub, photo, caption, loud) {
  const msg = await tg("sendPhoto", { chat_id: chatId, caption, parse_mode: "HTML", disable_notification: !loud, ...BTN }, photo.id || photo.png)
  if (msg.gone) return false
  photo.id ||= msg.photo?.at(-1)?.file_id
  // стару картку видаляємо (з нею зникає і копія в групі обговорень); не вийшло (старша 48 год) - хоча б відкріпити
  if (sub.msgId && !(await tg("deleteMessage", { chat_id: chatId, message_id: sub.msgId }))) await tg("unpinChatMessage", { chat_id: chatId, message_id: sub.msgId })
  await tg("pinChatMessage", { chat_id: chatId, message_id: msg.message_id, disable_notification: true })
  sub.msgId = msg.message_id
  return true
}

// нагадування для 96 слотів (сьогодні + завтра): at = хвилина, коли слати; t = момент переходу
export function reminders(all, nowMin, t0) {
  const out = []
  for (let j = 1; j < all.length; j++) {
    const off = all[j] === "off"
    if (off === (all[j - 1] === "off")) continue
    const t = j * 30
    if (t <= nowMin) continue
    let e = j; while (off && e < all.length && all[e] === "off") e++
    // тільки за 10 хв: вимкнення зі звуком, увімкнення тихо
    out.push({ id: `${t0 + j * 1800}:10`, at: t - 10, t, end: e * 30, off, silent: !off })
  }
  return out
}

// ---------- головне ----------
async function main() {
  const state = loadState()
  state.subs ??= {}
  if (CHAT) state.subs[CHAT] ??= {} // необов'язковий канал або чат, куди слати завжди

  // нові підписники: /start і /stop з моменту минулого запуску
  const joined = []
  let ups = []
  try { if (!DRY_RUN) ups = await tg("getUpdates", { offset: (state.offset ?? 0) + 1, allowed_updates: '["message","my_chat_member","callback_query"]' }) }
  catch (e) { console.log("getUpdates пропущено:", e.message) } // нові /start заберемо наступного разу
  for (const u of ups || []) {
    state.offset = u.update_id
    const m = u.message, cm = u.my_chat_member
    if (m?.chat?.type === "private" && /^\/start/.test(m.text || "")) { if (!state.subs[m.chat.id]) { state.subs[m.chat.id] = {}; joined.push(String(m.chat.id)) } }
    if (m?.chat?.type === "private" && /^\/stop/.test(m.text || "")) {
      delete state.subs[m.chat.id]
      await tg("sendMessage", { chat_id: m.chat.id, text: "Відписав. Щоб повернутись, натисніть /start" }).catch((e) => console.log("stop:", e.message))
    }
    if (cm?.new_chat_member?.status === "kicked") delete state.subs[cm.chat.id]
    if (OWNER && String((m || u.callback_query)?.from?.id) === String(OWNER)) await ownerCmd(state, m, u.callback_query).catch((e) => console.log("власник:", e.message))
  }

  const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL ?? "chrome" })
  try {
    const page = await browser.newPage()
    let res, f
    try {
      res = await fetchSchedule(page); f = res.fact
      if (!f?.data) throw new Error("ДТЕК не віддав графік")
    } catch (e) {
      // власнику один раз, якщо ДТЕК мовчить понад 30 хв
      console.log("ДТЕК недоступний:", e.message)
      if (OWNER && Date.now() - (state.lastOk ?? 0) > 30 * 60e3 && !state.staleWarned) {
        await tg("sendMessage", { chat_id: OWNER, text: `⚠️ Бот не може взяти графік з ДТЕК понад 30 хв: ${e.message}\nНагадування йдуть за останнім відомим графіком.` })
        state.staleWarned = true
      }
    }
    if (f) await publish(page, state, res, f, joined)
    await sensor(state).catch((e) => console.log("датчик:", e.message))
    await remind(state)
    console.log(`підписників: ${Object.keys(state.subs).length}`)
  } finally {
    saveState(state) // offset зберігаємо навіть при помилці ДТЕК, щоб не загубити /start
    await browser.close()
  }
}

// попередження ДТЕК («з 15:43 20.11.2026») ще попереду? запізніле, коли відключення вже йде, - не привід для гучного «Увага»
export const startsAhead = (d, now = Date.now()) => { const m = d?.match(/(\d+):(\d+) (\d+)\.(\d+)\.(\d+)/); return !m || new Date(m[5], m[4] - 1, m[3], m[1], m[2]) > now }

// свіжий графік: картки всім, підпис із «зараз»
async function publish(page, state, res, f, joined) {
    if (state.staleWarned && OWNER) await tg("sendMessage", { chat_id: OWNER, text: "✅ Графік з ДТЕК знову береться" })
    state.lastOk = Date.now(); state.staleWarned = false
    const key = `GPV${GROUP}`
    const now = new Date()
    const mid = new Date(now); mid.setHours(0, 0, 0, 0)
    const t0 = f.data[mid / 1000] ? mid / 1000 : Number(f.today)
    const today = toSlots(f.data[t0]?.[key])
    const tomorrow = toSlots(f.data[t0 + 86400]?.[key]) // shortcut: +86400 зсувається на годину в дні переходу на літній час, раз на рік
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const dToday = new Date(t0 * 1000), dTom = new Date((t0 + 86400) * 1000)

    const h = res.data?.[HOUSE] || {}
    const alert = h.sub_type ? `⚠️ <b>ДТЕК: ${h.sub_type}</b>${h.start_date ? ` з ${h.start_date}` : ""}${h.end_date ? ` до ${h.end_date}` : ""}` : ""
    const sig = JSON.stringify([t0, today, tomorrow, alert, GROUP, CARD_V])
    const body = [
      `⚡️ <b>${TITLE} · черга ${GROUP}</b>`, "",
      dayBlock("Сьогодні", dToday, today), "",
      dayBlock("Завтра", dTom, tomorrow), "",
      ...(alert ? [alert] : []),
      nowLine(today, tomorrow, nowMin),
      ...[LIVE && sensorLine(SENSOR, state.sensor, Date.now() / 1000)].filter(Boolean),
      `<i>ДТЕК оновив ${f.update}</i>`,
    ].join("\n")

    const newCard = sig !== state.sig
    const needCard = (id, sub) => newCard || joined.includes(id) || !sub.msgId || sub.retry
    const photo = {}
    if (Object.entries(state.subs).some(([id, sub]) => needCard(id, sub))) {
      await page.setViewportSize({ width: 1200, height: 600 })
      await page.setContent(cardHtml([{ name: "Сьогодні", date: dToday, slots: today }, { name: "Завтра", date: dTom, slots: tomorrow }], f.update))
      photo.png = await (await page.$(".card")).screenshot()
      fs.writeFileSync("grafik.png", photo.png)
    }
    if (newCard) {
      // новий графік (зі звуком) або нова доба (тихо) -> нова картка всім
      const [p0, pToday, pTom, pAlert, pGroup = "6.2"] = state.sig ? JSON.parse(state.sig) : []
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      state.head = pGroup !== GROUP ? `🔁 <b>Уточнили чергу: наш будинок живе за чергою ${GROUP}</b>\n\n`
        : p0 !== t0 ? ""
        : alert && alert !== pAlert && startsAhead(h.start_date) ? "⚠️ <b>Увага, відключення!</b>\n\n"
        : !same(pToday, today) ? "🔄 <b>Графік на сьогодні змінився!</b>\n\n"
        : !pTom && tomorrow ? "📅 <b>З'явився графік на завтра</b>\n\n"
        : !same(pTom, tomorrow) ? "🔄 <b>Графік на завтра змінився</b>\n\n" : ""
      state.sig = sig
    }
    const caption = state.head + body

    for (const [id, sub] of Object.entries(state.subs)) {
      let ok = true
      try {
      if (joined.includes(id)) {
        await tg("sendMessage", { chat_id: id, text: `Вітаю! Тепер я надсилатиму графік світла черги ${GROUP} для ${TITLE}: картинку на сьогодні й завтра, зміни графіка і нагадування за 10 хв до вимкнення та увімкнення.\n\nАктуальний графік завжди в закріпі. Відписатися: /stop` })
        ok = await sendCard(id, sub, photo, body, false)
      } else if (needCard(id, sub)) {
        // картку в закріпі оновлюємо на місці: без нових постів і рядків «pinned Deleted message»
        const media = JSON.stringify({ type: "photo", media: photo.id || "attach://photo", caption, parse_mode: "HTML" })
        const m = sub.msgId && !sub.retry && await tg("editMessageMedia", { chat_id: id, message_id: sub.msgId, media, ...BTN }, photo.id ? undefined : photo.png)
        if (m?.message_id || m?.same) photo.id ||= m.photo?.at(-1)?.file_id
        else ok = await sendCard(id, sub, photo, caption, false)
        // звук лише коли змінилось найближче: сьогодні, попередження ДТЕК, черга; завтра - тихо, тільки картка
        if (ok && newCard && /Увага|на сьогодні|Уточнили/.test(state.head)) {
          if (sub.alertId) await tg("deleteMessage", { chat_id: id, message_id: sub.alertId })
          const a = await tg("sendMessage", { chat_id: id, text: `${state.head.trim()}\nАктуальний графік у закріпі 👆`, parse_mode: "HTML" })
          if (a?.message_id) sub.alertId = a.message_id
        }
      }
      else if (sub.caption !== caption || sub.btn !== LIVE) ok = !(await tg("editMessageCaption", { chat_id: id, message_id: sub.msgId, caption, parse_mode: "HTML", ...BTN }))?.gone
      } catch (e) { console.log(`підписник ${id.slice(-4)}:`, e.message); sub.retry = true; continue } // дошлемо наступного запуску
      if (!ok) { delete state.subs[id]; continue }
      delete sub.retry
      sub.caption = joined.includes(id) ? body : caption
      sub.btn = LIVE
    }
    if (state.cache && state.cache.t0 !== t0) state.prevCache = state.cache // датчику для подій біля півночі
    state.cache = { t0, today, tomorrow } // для нагадувань, якщо ДТЕК ляже
    console.log(body)
}

// ---------- датчик ----------
const kb = (rows) => rows && JSON.stringify({ inline_keyboard: rows })
const PAUSE_KB = [[{ text: "⏸ Пауза (їду, вимикаю квартиру)", callback_data: "sp" }]], RESUME_KB = [[{ text: "▶️ Увімкнути датчик", callback_data: "sr" }]]

// власник: «датчик» - стан, «датчик пауза» / «датчик старт», і кнопки під повідомленнями
async function ownerCmd(state, m, q) {
  const mem = state.sensor ??= {}, now = Math.floor(Date.now() / 1000)
  if (q) {
    const [cmd, s] = q.data.split(":"), ask = mem.asked?.[s]
    const done = cmd === "sp" ? (mem.pause = { since: now }, "⏸ Датчик на паузі: у канал нічого не пишу")
      : cmd === "sr" ? (delete mem.pause, "▶️ Датчик знову стежить")
      : cmd === "oc" && ask ? (ask.ans = "ch", "📢 Пишу в канал")
      : cmd === "om" && ask ? (ask.ans = "me", mem.pause = { since: now, until: "on" }, "🙋 Зрозумів. Датчик на паузі, поки світло в квартирі не з'явиться") : "Застаріла кнопка"
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: done }).catch(() => {}) // кнопку могли натиснути давно
    if (q.message) await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${q.message.text}\n\n${done}` })
    return
  }
  const t = (m?.text || "").toLowerCase()
  if (!/^\/?(датчик|sensor)/.test(t)) return
  if (/пауз|pause|стоп/.test(t)) mem.pause = { since: now }
  if (/старт|увімк|resume|start/.test(t)) delete mem.pause
  const S = SENSOR, line = !fresh(S, now) ? `не на зв'язку${S?.t ? ` з ${new Date(S.t * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}` : ""}` : S.on ? `світло є, ${Math.round(S.v)} В` : "світла немає"
  await tg("sendMessage", { chat_id: m.chat.id, text: `🔌 Датчик: ${line}${mem.pause ? `\n⏸ На паузі ${D(now - mem.pause.since)}` : ""}`, reply_markup: kb(mem.pause ? RESUME_KB : PAUSE_KB) })
}

// події датчика: питання власнику і пости всім підписникам (редагуємо той самий пост, поки подія триває)
async function sensor(state) {
  const mem = state.sensor ??= {}, now = Math.floor(Date.now() / 1000)
  const slotAt = (ts) => slotFrom(state.cache, ts) ?? slotFrom(state.prevCache, ts)
  const { posts, owner } = sensorPlan(SENSOR, slotAt, mem, now)
  for (const o of owner) {
    if (!OWNER) continue
    const r = await tg("sendMessage", { chat_id: OWNER, text: o.text, reply_markup: kb(o.kb) })
    if (o.ask) mem.asked[o.ask] = { at: now, id: r.message_id }
  }
  for (const p of posts) {
    const msg = mem.msgs[p.key] ??= { ids: {} }
    const text = LIVE ? p.text : `🧪 Тест, у канал не пішло:\n${p.text}`
    if (msg.text !== p.text) for (const cid of LIVE ? Object.keys(state.subs) : [OWNER].filter(Boolean)) {
      try {
        if (msg.ids[cid]) await tg("editMessageText", { chat_id: cid, message_id: msg.ids[cid], text })
        else { const r = await tg("sendMessage", { chat_id: cid, text, disable_notification: !p.loud }); if (!r.gone) msg.ids[cid] = r.message_id }
      } catch (e) { console.log(`датчик ${cid.slice(-4)}:`, e.message) }
    }
    msg.text = p.text
    if (p.done) mem.done[p.key] = 1
  }
  prune(mem, now)
}

// нагадування з останнього відомого графіка (працює й тоді, коли ДТЕК не відповідає)
async function remind(state) {
    const c = state.cache
    if (!c) return
    const now = new Date()
    const mid = new Date(now); mid.setHours(0, 0, 0, 0)
    const shift = Math.round((mid / 1000 - c.t0) / 60) // хвилин від початку збереженої доби до сьогоднішньої
    const nowMin = now.getHours() * 60 + now.getMinutes() + shift
    const t0 = c.t0

    // момент з нагадування минув (світло дали / вимкнули) - прибираємо його з каналу, пост і так оновлений
    for (const [cid, sub] of Object.entries(state.subs)) if (sub.remindId && sub.remindAt && Date.now() / 1000 > sub.remindAt + 60) {
      await tg("deleteMessage", { chat_id: cid, message_id: sub.remindId }).catch(() => {})
      delete sub.remindId; delete sub.remindAt
    }

    // нагадування: за 30 хв до вимкнення тихо, за 10 хв зі звуком, за 10 хв до увімкнення тихо
    state.sent ??= []
    const all = [...(c.today || []), ...(c.tomorrow || [])]
    const due = reminders(all, nowMin, t0).filter((r) => !state.sent.includes(r.id))
    const wait = Math.min(...due.map((r) => r.at - nowMin).filter((d) => d > 0 && d <= 6))
    if (isFinite(wait) && !DRY_RUN) await new Promise((ok) => setTimeout(ok, (wait * 60 - new Date().getSeconds()) * 1000))
    const mNow = DRY_RUN ? nowMin : Math.max(nowMin, new Date().getHours() * 60 + new Date().getMinutes() + shift)
    const r = due.filter((r) => r.at <= mNow).at(-1) // запізнились - шлемо тільки найсвіжіше
    if (r) {
      const left = r.t - mNow
      const text = r.off ? `⏰ Через ${left} хв, о ${hm(r.t % 1440)}, вимкнення світла до ${hm(r.end % 1440)} (${dur(r.end - r.t)}). Заряджайте телефони 🔋`
        : `💡 Через ${left} хв, о ${hm(r.t % 1440)}, за графіком мають увімкнути світло`
      for (const [cid, sub] of Object.entries(state.subs)) {
        try {
          if (sub.remindId) await tg("deleteMessage", { chat_id: cid, message_id: sub.remindId })
          const m = await tg("sendMessage", { chat_id: cid, text, disable_notification: r.silent })
          if (m.gone) delete state.subs[cid]; else { sub.remindId = m.message_id; sub.remindAt = t0 + r.t * 60 }
        } catch (e) { console.log(`нагадування ${cid.slice(-4)}:`, e.message) }
      }
      state.sent = [...state.sent, ...due.filter((d) => d.at <= mNow).map((d) => d.id)].slice(-30)
    }
}

if (process.argv[2] === "test") {
  const assert = (await import("node:assert")).strict
  const s = toSlots({ ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, "yes"])), 11: "second", 12: "no", 18: "first", 24: "maybe" })
  assert.deepEqual(intervals(s), [{ start: 630, end: 720, kind: "off" }, { start: 1020, end: 1050, kind: "off" }, { start: 1380, end: 1440, kind: "maybe" }])
  assert.equal(nowLine(s, null, 640), "⚫️ <b>Зараз світла немає</b> · увімкнення о 12:00")
  assert.equal(nowLine(s, null, 100), "💡 <b>Зараз світло є</b> · вимкнення о 10:30")
  const all = [...s, ...Array(48).fill("on")]
  const rs = reminders(all, 600, 0)
  assert.deepEqual(rs.map((r) => [r.at, r.t, r.end, r.off, r.silent]), [[620, 630, 720, true, false], [710, 720, 720, false, true], [1010, 1020, 1050, true, false], [1040, 1050, 1050, false, true]])
  const at = new Date(2026, 10, 20, 16, 8).getTime()
  assert.equal(startsAhead("15:43 20.11.2026", at), false)
  assert.equal(startsAhead("18:00 20.11.2026", at), true)
  assert.equal(startsAhead(undefined, at), true)
  // датчик: s = вимкнення 10:30-12:00 і 17:00-17:30
  const { sensorPlan, sensorLine } = await import("./sensor.mjs")
  const t0 = new Date(2026, 10, 20).getTime() / 1000, tt = (h, m = 0) => t0 + h * 3600 + m * 60
  const slot = (ts) => slotFrom({ t0, today: s }, ts)
  const run = (S, mem, now) => sensorPlan({ up: 86400, ...S, t: now }, slot, mem, now)
  // світло дали із запізненням: спершу «досі немає» гучно, потім той самий пост «дали о 12:40»
  let mem = {}, r = run({ on: 0, v: 0, p: [[tt(10, 30), 0, 0]] }, mem, tt(12, 15))
  assert.deepEqual(r.posts.map((p) => [p.key, p.loud, !!p.done]), [[`lon:${tt(12)}`, true, false]])
  mem.msgs[r.posts[0].key] = { ids: {} }
  r = run({ on: 1, v: 230, p: [[tt(10, 30), tt(12, 40), 0]] }, mem, tt(12, 45))
  assert.match(r.posts[0].text, /дали о 12:40, на 40 хв пізніше/)
  // не вимкнули за графіком
  r = run({ on: 1, v: 229, p: [] }, {}, tt(17, 15))
  assert.deepEqual(r.posts.map((p) => p.key), [`lo:${tt(17)}`])
  // поза графіком: спершу питання власнику, без відповіді за 10 хв - пост у канал; «це я» - тиша і пауза до світла
  mem = {}; r = run({ on: 0, v: 0, p: [[tt(14), 0, 0]] }, mem, tt(14, 3))
  assert.equal(r.owner[0].ask, tt(14)); assert.equal(r.posts.length, 0)
  mem.asked[tt(14)] = { at: tt(14, 3) }
  assert.equal(run({ on: 0, v: 0, p: [[tt(14), 0, 0]] }, mem, tt(14, 8)).posts.length, 0)
  assert.deepEqual(run({ on: 0, v: 0, p: [[tt(14), 0, 0]] }, mem, tt(14, 14)).posts.map((p) => p.key), [`o:${tt(14)}`])
  mem = { asked: { [tt(14)]: { at: tt(14, 3), ans: "me" } }, pause: { since: tt(14, 4), until: "on" } }
  assert.equal(run({ on: 0, v: 0, p: [[tt(14), 0, 0]] }, mem, tt(14, 30)).posts.length, 0)
  r = run({ on: 1, v: 231, p: [[tt(14), tt(15), 0]] }, mem, tt(15, 5)); assert.equal(mem.pause, undefined); assert.match(r.owner[0].text, /знову стежить/)
  // спрацював захист від стрибка, коротке моргання без стрибка - мовчимо
  r = run({ on: 1, v: 230, p: [[tt(14), tt(14, 0) + 40, 268], [tt(14, 2), tt(14, 2) + 30, 230]] }, {}, tt(14, 5))
  assert.deepEqual(r.posts.map((p) => p.text), ["⚡️ О 14:00 стрибок напруги до 268 В: спрацював захист, світла не було 40 с (за датчиком)"])
  // пік проскочив між замірами (243 В), але світло повернулось через 2 хв = затримка ZUBR -> теж захист; 10 хв без світла -> ні
  r = run({ on: 1, v: 230, p: [[tt(14), tt(14, 2) + 5, 243]] }, {}, tt(14, 5))
  assert.deepEqual(r.posts.map((p) => p.text), ["⚡️ О 14:00 стрибок напруги: спрацював захист, світла не було 2 хв (за датчиком)"])
  r = run({ on: 1, v: 230, p: [[tt(14), tt(14, 10), 243]] }, {}, tt(14, 12))
  assert.equal(r.posts.length, 0); assert.equal(r.owner.length, 1)
  // висока напруга: триває -> пост, закінчилась -> підсумок; 30 с у межах 255 - тиша
  r = run({ on: 1, v: 258, x: [[tt(14), 0, 262]] }, {}, tt(14, 4))
  assert.equal(r.posts[0].text, "⚡️ Висока напруга: зараз 258 В, триває 4 хв, максимум 262 В (за датчиком)")
  r = run({ on: 1, v: 230, x: [[tt(14), tt(14, 14), 268], [tt(14, 15), tt(14, 15) + 30, 255]] }, {}, tt(14, 20))
  assert.deepEqual(r.posts.map((p) => p.text), ["⚡️ Висока напруга 14:00–14:14: трималась 14 хв, максимум 268 В (за датчиком). Зараз норма"])
  // повторні стрибки: ZUBR тримав квартиру 4,5 хв (пік 243 між замірами) -> теж захист
  r = run({ on: 1, v: 230, p: [[tt(14), tt(14, 4) + 30, 243]] }, {}, tt(14, 6))
  assert.match(r.posts[0].text, /спрацював захист, світла не було 5 хв \(мережа скакала/)
  // низька: 3 хв - тиша, 6 хв - тихий пост; нова подія за 2 год - не пишемо
  assert.equal(run({ on: 1, v: 200, x: [[tt(14), 0, 199]] }, {}, tt(14, 3)).posts.length, 0)
  mem = {}; r = run({ on: 1, v: 200, x: [[tt(14), 0, 198]] }, mem, tt(14, 6))
  assert.deepEqual(r.posts.map((p) => [p.text, p.loud]), [["🔻 Низька напруга: зараз 200 В, триває 6 хв, мінімум 198 В (за датчиком)", false]])
  mem.msgs[r.posts[0].key] = { ids: {} }
  r = run({ on: 1, v: 230, x: [[tt(14), tt(14, 20), 195], [tt(15), 0, 201]] }, mem, tt(15, 10))
  assert.deepEqual(r.posts.map((p) => p.key), [`x:${tt(14)}`])
  // рядок у закріпі з часом заміру
  assert.equal(sensorLine({ t: tt(18, 50), on: 1, v: 241.4 }, {}, tt(18, 52)), "🔌 За датчиком світло є · напруга 241 В (о 18:50)")
  // тижневий підсумок у неділю ввечері, раз на тиждень (22.11.2026 - неділя)
  mem = {}; const sun = tt(48 + 20, 1)
  run({ on: 1, v: 230, p: [[sun - 3600, sun - 3480, 249], [sun - 7200, sun - 5400, 230]], x: [[sun - 9000, sun - 8000, 258]] }, mem, sun - 100)
  r = run({ on: 1, v: 230 }, mem, sun)
  assert.match(r.posts.at(-1).text, /Світла не було: 2 рази, разом 32 хв[\s\S]*вимикав квартиру: 1 раз[\s\S]*максимум 258 В/)
  assert.equal(run({ on: 1, v: 230 }, mem, sun + 600).posts.length, 0)
  // пауза: нічого не пишемо і не дописуємо потім; датчик мовчить - власнику один раз
  mem = { pause: { since: tt(9) } }
  assert.equal(run({ on: 0, v: 0, p: [[tt(14), 0, 0]] }, mem, tt(14, 30)).owner.length, 0)
  mem = {}; const old = { t: tt(14), on: 1, v: 230 }
  assert.equal(sensorPlan(old, slot, mem, tt(14, 11)).owner.length, 1); assert.equal(sensorPlan(old, slot, mem, tt(14, 20)).owner.length, 0)
  console.log("ok")
} else await main()
