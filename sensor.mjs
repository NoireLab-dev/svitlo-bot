// Датчик у квартирі (ESP32 + PZEM-004T у розетці) -> що писати в канал і власнику.
// Чиста логіка без мережі: на вході знімок датчика, графік і пам'ять бота, на виході пости й питання власнику.
// Знімок S від прошивки: { t: зараз (unix), up: аптайм с, on: 0|1, v: вольти, p: [[початок, кінець|0, пік перед зникненням]], x: [[початок, кінець|0, пік]] }
export const NORM = [207, 253] // 230 В ±10%
const ZUBR = { hi: 255, back: 120 } // реле в щитку (ZUBR D25): вимикає від 255 В, повертає світло через 2 хв
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
  if (!S.on) { const o = (S.p || []).find(([, e]) => !e); return `🔌 За датчиком світла немає${o ? ` з ${at(o[0])}` : ""}` }
  return `🔌 За датчиком світло є, ${Math.round(S.v)} В${S.v > NORM[1] || S.v < NORM[0] ? " ⚠️" : ""}`
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
    // реле ZUBR відрубало квартиру на стрибку: пік перед зникненням або (пік проскочив між замірами) світло повернулось рівно через затримку реле
    const byPeak = pk > NORM[1], byDelay = pk >= ZUBR.hi - 15 && Math.abs(d - ZUBR.back) <= 20
    if (e && d < 600 && (byPeak || byDelay)) {
      want(`t:${s}`, now - e < 1800, { text: `⚡️ О ${at(s)} стрибок напруги${byPeak ? ` до ${pk} В` : ""}: спрацював захист, світла не було ${D(d)} (за датчиком)`, loud: true, done: true })
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

  // 3. напруга поза нормою: пишемо, якщо триває від хвилини або стрибок великий
  for (const [s, e, pk] of S.x || []) {
    const d = (e || now) - s, hi = pk > NORM[1]
    if (d < 60 && pk < 260 && pk > 190) continue
    const head = hi ? "⚡️ Висока напруга" : "🔻 Низька напруга", peak = `${hi ? "максимум" : "мінімум"} ${pk} В`
    want(`x:${s}`, !e || now - e < 1800, e ? { text: `${head} ${at(s)}–${at(e)}: трималась ${D(d)}, ${peak} (за датчиком)${S.on ? ". Зараз норма" : ""}`, loud: false, done: true }
      : { text: `${head}: зараз ${Math.round(S.v)} В, триває ${D(d)}, ${peak} (за датчиком)`, loud: hi })
  }
  return { posts, owner }
}

// стара пам'ять (ключі з часом) - геть через 2 доби
export function prune(mem, now) {
  for (const k of ["done", "msgs"]) for (const key of Object.keys(mem[k] || {})) if (now - Number(key.split(":")[1]) > 2 * 86400) delete mem[k][key]
  for (const s of Object.keys(mem.asked || {})) if (now - Number(s) > 2 * 86400) delete mem.asked[s]
}
