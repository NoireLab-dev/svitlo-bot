// Датчик у квартирі (ESP32 + PZEM-004T у розетці) -> що писати в канал і власнику.
// Чиста логіка без мережі: на вході знімок датчика, графік і пам'ять бота, на виході пости й питання власнику.
// Знімок S від прошивки: { t: зараз (unix), up: аптайм с, on: 0|1, v: вольти, p: [[початок, кінець|0, пік перед зникненням]], x: [[початок, кінець|0, пік]] }
export const NORM = [207, 253] // 230 В ±10%: тривога з 254 і 206 В (прошивка шле піки цілими)
const ZUBR = { hi: 255, back: 120 } // реле в щитку (ZUBR D25): вимикає від 255 В, повертає світло через 2 хв спокійної мережі (новий стрибок - відлік спочатку)
const LOW_MIN = 300, X_GAP = 7200 // низька напруга - пост від 5 хв; нова подія з напругою не раніше ніж за 2 год після попередньої
const OFF = ["off", "maybe"]

const at = (ts) => { const d = new Date(ts * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` }
export const D = (sec) => {
  if (sec < 60) return `${Math.round(sec)} с`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год${m % 60 ? ` ${m % 60} хв` : ""}`
}

// слот графіка на момент ts із картки { t0, today, tomorrow }
export const slotFrom = (c, ts) => {
  if (!c) return
  const i = Math.floor((ts - c.t0) / 1800)
  return i < 48 ? c.today?.[i] : c.tomorrow?.[i - 48]
}

export const fresh = (S, now) => !!S?.t && now - S.t < 600

// рядок у підпис закріпу
export function sensorLine(S, mem, now) {
  if (mem?.pause) return "⏸ Датчик у квартирі на паузі"
  if (!fresh(S, now)) return ""
  if (!S.on) {
    const o = (S.p || []).find(([, e]) => !e)
    // реле стоїть лише в нашій квартирі: у будинку світло є, але напруга небезпечна
    if (o && (o[2] > NORM[1] || (o[2] > 0 && o[2] < NORM[0]))) return `🛡 Напруга в мережі поза нормою (${o[2]} В): реле в квартирі з датчиком відключило її о ${at(o[0])}`
    return `🔌 За датчиком світла немає${o ? ` з ${at(o[0])}` : ""}`
  }
  const v = Math.round(S.v)
  return `🔌 За датчиком світло є · напруга ${v} В${v > NORM[1] || v < NORM[0] ? " ⚠️" : ""} (о ${at(S.t)})`
}

export function sensorPlan(S, slotAt, mem, now) {
  const posts = [], owner = []
  mem.done ??= {}; mem.msgs ??= {}; mem.asked ??= {}

  // зв'язок із датчиком: мовчить 10 хв -> власнику один раз
  if (!fresh(S, now)) {
    if (S?.t && !mem.silentWarned && !mem.pause) { owner.push({ text: `📡 Датчик не на зв'язку з ${at(S.t)}. Перевірте живлення плати й Wi-Fi.` }); mem.silentWarned = true }
    return { posts, owner }
  }
  if (mem.silentWarned) { owner.push({ text: "📡 Датчик знову на зв'язку" }); mem.silentWarned = false }

  // пауза: «це я вимкнув» знімається сама, щойно світло повернулось; ручна нагадує про себе через 3 дні
  if (mem.pause?.until === "on" && S.on) { delete mem.pause; owner.push({ text: "▶️ Світло в квартирі є, датчик знову стежить" }) }
  if (mem.pause && now - mem.pause.since > 3 * 86400 && !mem.pause.warned) {
    owner.push({ text: "⏸ Датчик на паузі вже 3 дні. Увімкнути?", kb: [[{ text: "▶️ Увімкнути датчик", callback_data: "sr" }]] })
    mem.pause.warned = true
  }
  const paused = !!mem.pause
  const from = S.t - (S.up ?? 0) // до перезапуску плати історії немає
  const outs = (S.p || []).filter(([s]) => s >= from)
  const isMine = (s) => mem.asked[s]?.ans === "me"

  // key - один пост, який редагуємо, поки подія триває; recent - чи варто взагалі про неї писати
  const want = (key, recent, post) => {
    if (mem.done[key]) return
    if (!mem.msgs[key]) { if (paused) { mem.done[key] = 1; return } if (!recent) return }
    posts.push({ key, ...post })
  }

  // 1. світло зникло поза графіком
  for (const [s, e, pk] of outs) {
    if (OFF.includes(slotAt(s)) || OFF.includes(slotAt(s + 900))) continue // за графіком (або трохи раніше)
    const d = (e || now) - s
    // реле ZUBR відрубало квартиру на стрибку: пік перед зникненням або (пік проскочив між замірами) висока напруга і світло повернулось
    // не раніше затримки реле (повторні стрибки продовжують паузу; датчик після ZUBR їх не бачить)
    // просадка: прошивка з fw6 зберігає мінімум перед зникненням; старша - лише епізод низької напруги, що обірвався разом зі світлом
    const low = (pk > 0 && pk < NORM[0]) || (S.x || []).some(([, xe, xp]) => xp < NORM[0] && xe && Math.abs(xe - s) <= 5)
    const byPeak = pk > NORM[1] || low, byDelay = pk >= ZUBR.hi - 15 && d >= ZUBR.back - 20
    if (byPeak || (e && d < 600 && byDelay)) {
      if (!e && d < 300) continue // реле ще може повернути світло за 2 хв - чекаємо
      // реле лише в квартирі з датчиком: у сусідів без реле світло було, але з небезпечною напругою
      const why = low ? `🔻 О ${at(s)} просадка напруги в мережі${pk > 0 && pk < NORM[0] ? ` до ${pk} В` : ""}` : `⚡️ О ${at(s)} стрибок напруги в мережі${pk > NORM[1] ? ` до ${pk} В` : ""}`
      want(`t:${s}`, !e || now - e < 1800, e
        ? { text: `${why}. Реле захисту в квартирі з датчиком відключало живлення на ${D(d)}${d > ZUBR.back + 30 ? ", бо мережа скакала" : ""}. Без реле напруги техніка в цей час під ударом (за датчиком)`, loud: true, done: true }
        : { text: `${why}. Реле захисту в квартирі з датчиком тримає живлення відключеним уже ${D(d)}, тож точної напруги зараз не видно. Без реле напруги краще вимкнути чутливу техніку (за датчиком)`, loud: true })
      continue
    }
    if (e && d < 120) continue // моргнуло
    const key = `o:${s}`, ask = mem.asked[s]
    if (isMine(s) || mem.done[key]) continue
    if (!ask && !mem.msgs[key]) {
      // спершу питаємо власника: квартиру міг знеструмити він сам
      if (paused) mem.done[key] = 1
      else if (now - s < 3 * 3600) owner.push({ ask: s, text: `⚫️ Датчик: світла немає з ${at(s)}, а за графіком воно мало бути.\nЦе відключення чи ви вимкнули квартиру самі? Без відповіді за 10 хв напишу в канал.`,
        kb: [[{ text: "📢 Відключення, в канал", callback_data: `oc:${s}` }, { text: "🙋 Це я вимкнув", callback_data: `om:${s}` }]] })
      continue
    }
    const waited = ask && now - ask.at >= 600
    if (!mem.msgs[key] && ask?.ans !== "ch" && !(waited && (!e || d >= 600))) continue
    want(key, true, e ? { text: `⚫️ Світла не було поза графіком: ${at(s)}–${at(e)}, ${D(d)} (за датчиком)`, loud: false, done: true }
      : { text: `⚫️ Світло зникло о ${at(s)} поза графіком, немає вже ${D(d)} (за датчиком)`, loud: true })
  }

  // 2. графік каже одне, а датчик бачить інше (перехід T, через 10 хв після нього)
  for (let T = Math.ceil((now - 6 * 3600) / 1800) * 1800; T <= now - 600; T += 1800) {
    const a = slotAt(T - 1), b = slotAt(T)
    if (!a || !b || a === b || a === "maybe" || b === "maybe" || T - 900 < from) continue
    if (b === "off") {
      if (outs.some(([s, e]) => s <= T + 600 && (!e || e > T - 900))) continue // вимкнули вчасно або вже не було
      let E = T; while (slotAt(E) === "off") E += 1800
      const late = outs.find(([s]) => s > T + 600 && s < E)
      want(`lo:${T}`, late ? now - late[0] < 1800 : now - E < 1800,
        late ? { text: `💡 Світло вимкнули о ${at(late[0])}, на ${D(late[0] - T)} пізніше графіка (за датчиком)`, loud: false, done: true }
        : now < E ? { text: `💡 За графіком світло мали вимкнути о ${at(T)}, але воно досі є (за датчиком)`, loud: false }
        : { text: `💡 За графіком світла не мало бути ${at(T)}–${at(E)}, але його так і не вимкнули (за датчиком)`, loud: false, done: true })
    } else {
      const o = outs.find(([s, e]) => s <= T + 600 && (!e || e > T + 600))
      if (!o || isMine(o[0])) continue
      const [, e] = o
      want(`lon:${T}`, !e || now - e < 1800, e ? { text: `💡 Світло дали о ${at(e)}, на ${D(e - T)} пізніше графіка (за датчиком)`, loud: false, done: true }
        : { text: `⚫️ За графіком світло мали дати о ${at(T)}, але його досі немає: запізнення вже ${D(now - T)} (за датчиком)`, loud: true })
    }
  }

  // 3. напруга поза нормою: висока - від хвилини, низька - від 5 хв; короткі - тільки в тижневий підсумок
  for (const [s, e, pk] of S.x || []) {
    const d = (e || now) - s, hi = pk > NORM[1]
    if (d < (hi ? 60 : LOW_MIN)) continue
    const key = `x:${s}`
    if (!mem.msgs[key] && !mem.done[key]) { // нова подія: не частіше ніж раз на 2 год
      if (now - (mem.lastX ?? 0) < X_GAP) { mem.done[key] = 1; continue }
      if (!paused && (!e || now - e < 1800)) mem.lastX = now
    }
    const head = hi ? "⚡️ Висока напруга" : "🔻 Низька напруга", peak = `${hi ? "максимум" : "мінімум"} ${pk} В`
    want(key, !e || now - e < 1800, e ? { text: `${head} ${at(s)}–${at(e)}: трималась ${D(d)}, ${peak} (за датчиком)${S.on ? ". Зараз норма" : ""}`, loud: false, done: true }
      : { text: `${head}: зараз ${Math.round(S.v)} В, триває ${D(d)}, ${peak} (за датчиком)`, loud: hi })
  }
  log(S, mem, from)
  const wk = weekly(mem, now)
  if (wk) posts.push(wk)
  return { posts, owner }
}

const times = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "раз" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "рази" : "разів"}`

// журнал завершених подій для тижневого підсумку (і для скарги на напругу)
function log(S, mem, from) {
  mem.log ??= []
  for (const [k, list] of [["p", S.p], ["x", S.x]]) for (const [s, e, pk] of list || []) {
    if (!e || s < from || mem.log.some((l) => l[0] === k && l[1] === s)) continue
    mem.log.push([k, s, e, pk])
  }
}

// неділя після 20:00 - тихий підсумок за 7 днів, раз на тиждень
export function weekly(mem, now) {
  const d = new Date(now * 1000), wkKey = `w:${now - (now % 86400)}`
  if (d.getDay() !== 0 || d.getHours() < 20 || mem.lastWeek && now - mem.lastWeek < 5 * 86400) return
  mem.lastWeek = now
  const L = (mem.log || []).filter((l) => now - l[1] < 7 * 86400)
  const isTrip = (l) => l[3] > NORM[1] || (l[3] > 0 && l[3] < NORM[0]) || (l[2] - l[1] < 600 && l[3] >= ZUBR.hi - 15)
  const trips = L.filter((l) => l[0] === "p" && isTrip(l)), outs = L.filter((l) => l[0] === "p" && !isTrip(l) && l[2] - l[1] >= 120)
  const hi = L.filter((l) => l[0] === "x" && l[3] > NORM[1]), lo = L.filter((l) => l[0] === "x" && l[3] < NORM[0])
  const off = outs.reduce((a, l) => a + l[2] - l[1], 0)
  const lines = [
    "📊 Тиждень за датчиком",
    `⚫️ Світла не було: ${outs.length ? `${times(outs.length)}, разом ${D(off)}` : "жодного разу"}`,
    `🛡 Небезпечна напруга, реле відключало квартиру з датчиком: ${trips.length ? times(trips.length) : "жодного разу"}`,
    `📈 Висока напруга (від 254 В): ${hi.length ? times(hi.length) : "не було"}${hi.length ? `, максимум ${Math.max(...hi.map((l) => l[3]))} В` : ""}`,
    `🔻 Низька напруга (до 206 В): ${lo.length ? times(lo.length) : "не було"}${lo.length ? `, мінімум ${Math.min(...lo.map((l) => l[3]))} В` : ""}`,
  ]
  return { key: wkKey, text: lines.join("\n"), loud: false, done: true }
}

// стара пам'ять (ключі з часом) - геть через 2 доби
export function prune(mem, now) {
  for (const k of ["done", "msgs"]) for (const key of Object.keys(mem[k] || {})) if (now - Number(key.split(":")[1]) > 2 * 86400) delete mem[k][key]
  for (const s of Object.keys(mem.asked || {})) if (now - Number(s) > 2 * 86400) delete mem.asked[s]
  if (mem.log) mem.log = mem.log.filter((l) => now - l[1] < 8 * 86400)
}
