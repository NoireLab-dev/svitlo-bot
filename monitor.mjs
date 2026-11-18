// Бот графиків ДТЕК КРЕМ для одного будинку: картинка + живий підпис у закріпі, нагадування за 30 і 10 хв.
// Сусіди підписуються на бота (/start). Запуск раз на 10 хв (GitHub Actions). Стан у state.bin.
import { chromium } from "playwright"
import fs from "node:fs"
import crypto from "node:crypto"

const { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, DRY_RUN, STATE_KEY } = process.env
const CITY = process.env.CITY || "м. Ірпінь"
const STREET = process.env.STREET || "вул. Джерельна"
const GROUP = process.env.GROUP || "6.2"
const TITLE = process.env.TITLE || "Джерельна 10"
const HOUSE = process.env.HOUSE || "10"
const OWNER = process.env.OWNER_CHAT_ID
const STATE_FILE = "state.bin"
const DAYS = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"]

// ---------- дані ----------
async function fetchSchedule(page) {
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
function cardHtml(rows, nowMin, updated) {
  const row = ({ name, date, slots }, isToday) => {
    const cells = slots
      ? slots.map((v) => `<i class="${v}"></i>`).join("")
      : `<div class="none">графіка ще немає</div>`
    const now = isToday ? `<b class="now" style="left:calc(${(nowMin / 1440) * 100}% - 1px)"></b>` : ""
    return `<div class="row"><div class="lbl"><div>${name}</div><span>${dayLabel(date)}</span></div><div class="bar">${cells}${now}</div></div>`
  }
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>`).join("")
  return `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box} body{width:1200px;background:#0b1220;font:500 26px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif;color:#e8edf7}
  .card{padding:44px 48px 40px;background:radial-gradient(1200px 400px at 0 0,#13284a 0,#0b1220 60%)}
  .head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:34px}
  h1{font-size:46px;font-weight:800;letter-spacing:-.5px} h1 em{font-style:normal;color:#ffd500}
  .grp{display:inline-block;margin-top:10px;padding:6px 16px;border-radius:999px;background:#0057b7;font-size:24px;font-weight:700}
  .upd{color:#8a97ad;font-size:22px;text-align:right}
  .row{display:flex;align-items:center;gap:24px;margin-bottom:22px}
  .lbl{width:150px} .lbl div{font-size:28px;font-weight:700} .lbl span{color:#8a97ad;font-size:22px}
  .bar{position:relative;flex:1;height:78px;display:grid;grid-template-columns:repeat(48,1fr);gap:3px}
  .bar i{border-radius:5px} .on{background:#ffd500} .off{background:#1d2a40;box-shadow:inset 0 0 0 2px #2c3d5c}
  .maybe{background:repeating-linear-gradient(135deg,#ffd500 0 8px,#1d2a40 8px 16px)}
  .bar i:nth-child(2n){margin-right:2px}
  .none{grid-column:1/-1;display:flex;align-items:center;justify-content:center;border:2px dashed #2c3d5c;border-radius:10px;color:#8a97ad}
  .now{position:absolute;top:-10px;bottom:-10px;width:4px;background:#fff;border-radius:2px;box-shadow:0 0 0 3px #0b1220}
  .axis{position:relative;margin:6px 0 0 174px;height:28px;color:#8a97ad;font-size:20px} .axis span{position:absolute;transform:translateX(-50%)}
  .leg{display:flex;gap:30px;margin-top:26px;color:#aab4c6;font-size:22px} .leg b{display:inline-block;width:22px;height:22px;border-radius:5px;vertical-align:-4px;margin-right:8px}
  </style><div class="card">
  <div class="head"><div><h1>⚡ ${TITLE} <em>· Ірпінь</em></h1><div class="grp">Черга ${GROUP}</div></div><div class="upd">ДТЕК оновив<br>${updated}</div></div>
  ${row(rows[0], true)}${row(rows[1], false)}
  <div class="axis">${ticks}</div>
  <div class="leg"><span><b class="on"></b>світло є</span><span><b class="off"></b>відключення</span><span><b class="maybe"></b>можливе</span><span><b style="background:#fff;width:6px"></b>зараз</span></div>
  </div>`
}

// ---------- Telegram ----------
const GONE = /blocked|deactivated|chat not found|user is deactivated/
async function tg(method, params, file) {
  if (DRY_RUN) { console.log("[dry]", method, params.chat_id ?? "", (params.caption || params.text || "").slice(0, 60)); return { message_id: 1 } }
  let body
  if (file && typeof file !== "string") {
    body = new FormData()
    for (const [k, v] of Object.entries(params)) body.append(k, String(v))
    body.append("photo", new Blob([file], { type: "image/png" }), "grafik.png")
  } else body = new URLSearchParams(Object.entries(file ? { ...params, photo: file } : params).map(([k, v]) => [k, String(v)]))
  const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", body })).json()
  if (!r.ok && GONE.test(r.description)) return { gone: true }
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

// надіслати картку одному підписнику і закріпити в його чаті
async function sendCard(chatId, sub, photo, caption, loud) {
  const msg = await tg("sendPhoto", { chat_id: chatId, caption, parse_mode: "HTML", disable_notification: !loud }, photo.id || photo.png)
  if (msg.gone) return false
  photo.id ||= msg.photo?.at(-1)?.file_id
  if (sub.msgId) await tg("unpinChatMessage", { chat_id: chatId, message_id: sub.msgId })
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
    const ths = off ? [[30, true], [10, false]] : [[10, true]]
    for (const [m, silent] of ths) out.push({ id: `${t0}:${j}:${m}`, at: t - m, t, end: e * 30, off, silent })
  }
  // 30-хвилинне не шлемо, якщо вже час 10-хвилинного
  return out.filter((r) => !(r.silent && r.off && nowMin >= r.t - 10))
}

// ---------- головне ----------
async function main() {
  const state = loadState()
  state.subs ??= {}
  if (CHAT) state.subs[CHAT] ??= {} // необов'язковий канал або чат, куди слати завжди

  // нові підписники: /start і /stop з моменту минулого запуску
  const joined = []
  const ups = DRY_RUN ? [] : await tg("getUpdates", { offset: (state.offset ?? 0) + 1, allowed_updates: '["message","my_chat_member"]' })
  for (const u of ups || []) {
    state.offset = u.update_id
    const m = u.message, cm = u.my_chat_member
    if (m?.chat?.type === "private" && /^\/start/.test(m.text || "")) { if (!state.subs[m.chat.id]) { state.subs[m.chat.id] = {}; joined.push(String(m.chat.id)) } }
    if (m?.chat?.type === "private" && /^\/stop/.test(m.text || "")) {
      delete state.subs[m.chat.id]
      await tg("sendMessage", { chat_id: m.chat.id, text: "Відписав. Щоб повернутись, натисніть /start" })
    }
    if (cm?.new_chat_member?.status === "kicked") delete state.subs[cm.chat.id]
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
      if (OWNER && Date.now() - (state.lastOk ?? 0) > 30 * 60e3 && !state.staleWarned) {
        await tg("sendMessage", { chat_id: OWNER, text: `⚠️ Бот не може взяти графік з ДТЕК понад 30 хв: ${e.message}` })
        state.staleWarned = true
      }
      throw e
    }
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
    const sig = JSON.stringify([t0, today, tomorrow, alert])
    const body = [
      `⚡️ <b>${TITLE} · черга ${GROUP}</b>`, "",
      dayBlock("Сьогодні", dToday, today), "",
      dayBlock("Завтра", dTom, tomorrow), "",
      ...(alert ? [alert] : []),
      nowLine(today, tomorrow, nowMin),
      `<i>ДТЕК оновив ${f.update}</i>`,
    ].join("\n")

    const newCard = sig !== state.sig
    const photo = {}
    if (newCard || joined.length || Object.values(state.subs).some((s) => !s.msgId)) {
      await page.setViewportSize({ width: 1200, height: 600 })
      await page.setContent(cardHtml([{ name: "Сьогодні", date: dToday, slots: today }, { name: "Завтра", date: dTom, slots: tomorrow }], nowMin, f.update))
      photo.png = await (await page.$(".card")).screenshot()
      fs.writeFileSync("grafik.png", photo.png)
    }
    if (newCard) {
      // новий графік (зі звуком) або нова доба (тихо) -> нова картка всім
      const [p0, pToday, pTom, pAlert] = state.sig ? JSON.parse(state.sig) : []
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      state.head = p0 !== t0 ? ""
        : alert && alert !== pAlert ? "⚠️ <b>Увага, відключення!</b>\n\n"
        : !same(pToday, today) ? "🔄 <b>Графік на сьогодні змінився!</b>\n\n"
        : !pTom && tomorrow ? "📅 <b>З'явився графік на завтра</b>\n\n"
        : !same(pTom, tomorrow) ? "🔄 <b>Графік на завтра змінився</b>\n\n" : ""
      state.sig = sig
    }
    const caption = state.head + body

    for (const [id, sub] of Object.entries(state.subs)) {
      let ok = true
      if (joined.includes(id)) {
        await tg("sendMessage", { chat_id: id, text: `Вітаю! Тепер я надсилатиму графік світла черги ${GROUP} для ${TITLE}: картинку на сьогодні й завтра, зміни графіка і нагадування за 30 і 10 хв до вимкнення.\n\nАктуальний графік завжди в закріпі. Відписатися: /stop` })
        ok = await sendCard(id, sub, photo, body, false)
      } else if (newCard || !sub.msgId) ok = await sendCard(id, sub, photo, caption, !!state.head)
      else if (sub.caption !== caption) ok = !(await tg("editMessageCaption", { chat_id: id, message_id: sub.msgId, caption, parse_mode: "HTML" }))?.gone
      if (!ok) { delete state.subs[id]; continue }
      sub.caption = joined.includes(id) ? body : caption
    }

    // нагадування: за 30 хв до вимкнення тихо, за 10 хв зі звуком, за 10 хв до увімкнення тихо
    state.sent ??= []
    const all = [...(today || []), ...(tomorrow || [])]
    const due = reminders(all, nowMin, t0).filter((r) => !state.sent.includes(r.id))
    const wait = Math.min(...due.map((r) => r.at - nowMin).filter((d) => d > 0 && d <= 6))
    if (isFinite(wait) && !DRY_RUN) await new Promise((ok) => setTimeout(ok, (wait * 60 - new Date().getSeconds()) * 1000))
    const mNow = DRY_RUN ? nowMin : Math.max(nowMin, new Date().getHours() * 60 + new Date().getMinutes())
    const r = due.filter((r) => r.at <= mNow).at(-1) // запізнились - шлемо тільки найсвіжіше
    if (r) {
      const left = r.t - mNow
      const text = r.off ? `⏰ Через ${left} хв, о ${hm(r.t % 1440)}, вимкнення світла до ${hm(r.end % 1440)} (${dur(r.end - r.t)}). Заряджайте телефони 🔋`
        : `💡 Через ${left} хв, о ${hm(r.t % 1440)}, за графіком мають увімкнути світло`
      for (const [cid, sub] of Object.entries(state.subs)) {
        if (sub.remindId) await tg("deleteMessage", { chat_id: cid, message_id: sub.remindId })
        const m = await tg("sendMessage", { chat_id: cid, text, disable_notification: r.silent })
        if (m.gone) delete state.subs[cid]; else sub.remindId = m.message_id
      }
      state.sent = [...state.sent, ...due.filter((d) => d.at <= mNow).map((d) => d.id)].slice(-30)
    }
    console.log(body, `\nпідписників: ${Object.keys(state.subs).length}`)
  } finally {
    saveState(state) // offset зберігаємо навіть при помилці ДТЕК, щоб не загубити /start
    await browser.close()
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
  assert.deepEqual(rs.map((r) => [r.at, r.t, r.end, r.off, r.silent]), [[600, 630, 720, true, true], [620, 630, 720, true, false], [710, 720, 720, false, true], [990, 1020, 1050, true, true], [1010, 1020, 1050, true, false], [1040, 1050, 1050, false, true]])
  assert.equal(reminders(all, 625, 0)[0].at, 620) // о 10:25 вже лише 10-хвилинне
  console.log("ok")
} else await main()
